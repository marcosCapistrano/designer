import ts from '@typescript/typescript6';
import { validateDoc, type DesignDoc, type DesignNode, type ElementNode, type StyleMap } from '@hub/design-model';
import { applyStyles, parseStyles } from './css.js';
import type { ExtractResult, RouteEntry, SourceProject } from './types.js';

// No ambient clock, filesystem or execution: extraction is a pure function of source text.
function stableId(key: string): string {
  let a = 2166136261, b = 5381;
  for (const char of key) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

function jsxText(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.toLowerCase().startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code > 0x10ffff || code === 0 || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid JSX character entity');
      return String.fromCodePoint(code);
    }
    const decoded = named[entity];
    if (decoded === undefined) throw new Error(`Unsupported JSX entity &${entity};`);
    return decoded;
  });
}

function resolveFile(project: SourceProject, from: string, specifier: string): string {
  if (!specifier.startsWith('.')) throw new Error(`External import ${specifier} needs a preview adapter`);
  const segments = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') { if (!segments.length) throw new Error('Import escapes source root'); segments.pop(); }
    else if (part !== '.') segments.push(part);
  }
  const base = segments.join('/');
  const matches = [base, `${base}.tsx`, `${base}.jsx`, `${base}.ts`, `${base}.js`, `${base}/index.tsx`, `${base}/index.jsx`]
    .filter((file) => Object.hasOwn(project.files, file));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous import ${specifier} from ${from}`);
  return matches[0]!;
}

type Value = string | number | boolean | null | Record<string, unknown> | DesignNode[];
interface Module { source: ts.SourceFile; imports: Map<string, { file: string; name: string }>; styles: Map<string, string>; constants: Map<string, ts.Expression> }

export function extractPages(project: SourceProject, entries: RouteEntry[]): ExtractResult {
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const dependencies: Record<string, string[]> = {};
  const diagnostics: { file: string; message: string }[] = [];
  const seenRoutes = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0)) {
    let currentFile = entry.file;
    try {
      if (!entry.route.startsWith('/') || seenRoutes.has(entry.route)) throw new Error(`Invalid or duplicate route ${entry.route}`);
      seenRoutes.add(entry.route);
      if ([entry.file, ...(entry.layouts ?? [])].some((file) => file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.' || part === ''))) throw new Error('Source paths must be relative POSIX paths');
      const files = new Set<string>();
      const loadedStyles = new Set<string>();
      const modules = new Map<string, Module>();
      const rules: ReturnType<typeof parseStyles> = [];
      const inline = new Map<string, StyleMap>();
      const stack: string[] = [];
      const namespace = stableId(entry.route);
      const nodeId = (file: string, path: string) => `s${stableId(`${namespace}:${file}:${path}`)}`;
      function module(file: string): Module {
        currentFile = file;
        const cached = modules.get(file); if (cached) return cached;
        const text = project.files[file]; if (text === undefined) throw new Error(`Missing source ${file}`);
        files.add(file);
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const parsed = source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
        if (parsed.parseDiagnostics.length) throw new Error('Invalid JSX/TypeScript syntax');
        const mod: Module = { source, imports: new Map(), styles: new Map(), constants: new Map() };
        modules.set(file, mod);
        for (const statement of source.statements) {
          if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            if (specifier.endsWith('.css')) {
              const cssFile = resolveFile(project, file, specifier); files.add(cssFile);
              const scope = cssFile.endsWith('.module.css') ? `c${stableId(cssFile)}` : null;
              if (!loadedStyles.has(cssFile)) {
                currentFile = cssFile;
                rules.push(...parseStyles(project.files[cssFile]!, scope));
                currentFile = file;
                loadedStyles.add(cssFile);
              }
              if (statement.importClause?.name) {
                if (!scope) throw new Error('Default CSS imports require CSS Modules');
                mod.styles.set(statement.importClause.name.text, scope);
              }
            } else if (statement.importClause && !statement.importClause.isTypeOnly) {
              const clause = statement.importClause;
              if (clause.name) mod.imports.set(clause.name.text, { file: specifier, name: 'default' });
              if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) mod.imports.set(binding.name.text, { file: specifier, name: binding.propertyName?.text ?? binding.name.text });
              }
            } else if (!statement.importClause) throw new Error(`Side-effect import ${specifier} needs a preview adapter`);
          }
          if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer) mod.constants.set(declaration.name.text, declaration.initializer);
          }
        }
        return mod;
      }
      function value(expression: ts.Expression, mod: Module, env: Record<string, Value>, depth = 0): Value {
        if (depth > 30) throw new Error('Cyclic or deeply nested constant');
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return value(expression.expression, mod, env, depth + 1);
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
        if (ts.isNumericLiteral(expression)) return Number(expression.text);
        if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
        if (ts.isIdentifier(expression)) {
          if (Object.hasOwn(env, expression.text)) return env[expression.text]!;
          const constant = mod.constants.get(expression.text);
          if (constant) return value(constant, mod, env, depth + 1);
        }
        if (ts.isPropertyAccessExpression(expression)) {
          if (ts.isIdentifier(expression.expression)) {
            const scope = mod.styles.get(expression.expression.text);
            if (scope) return `${scope}__${expression.name.text}`;
          }
          const object = value(expression.expression, mod, env, depth + 1);
          if (object && typeof object === 'object' && !Array.isArray(object) && Object.hasOwn(object, expression.name.text)) return object[expression.name.text] as Value;
        }
        if (ts.isObjectLiteralExpression(expression)) {
          const result: Record<string, unknown> = {};
          for (const property of expression.properties) {
            if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) throw new Error('Unsupported object property');
            if (['__proto__', 'constructor', 'prototype'].includes(property.name.text)) throw new Error('Reserved object property');
            result[property.name.text] = value(property.initializer, mod, env, depth + 1);
          }
          return result;
        }
        throw new Error(`Dynamic expression needs a saved preview choice: ${expression.getText(mod.source).slice(0, 100)}`);
      }
      function renderComponent(file: string, name: string, props: Record<string, Value>, path: string): DesignNode[] {
        const mod = module(file);
        const key = `${file}:${name}`;
        if (stack.includes(key) || stack.length > 40) throw new Error(`Recursive component ${key}`);
        stack.push(key);
        try {
          let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
          for (const statement of mod.source.statements) {
            if (ts.isFunctionDeclaration(statement) && (name === 'default' ? statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) : statement.name?.text === name)) fn = statement;
            if (ts.isExportAssignment(statement) && name === 'default') {
              const expression = statement.expression;
              if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) fn = expression;
              else if (ts.isIdentifier(expression)) {
                const local = mod.constants.get(expression.text);
                if (local && (ts.isArrowFunction(local) || ts.isFunctionExpression(local))) fn = local;
                else return renderComponent(file, expression.text, props, path);
              }
            }
            if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) fn = declaration.initializer;
            }
          }
          if (!fn?.body) throw new Error(`Cannot resolve component export ${name} in ${file}`);
          const env: Record<string, Value> = {};
          const parameter = fn.parameters[0];
          if (parameter) {
            if (ts.isIdentifier(parameter.name)) env[parameter.name.text] = props;
            else if (ts.isObjectBindingPattern(parameter.name)) for (const binding of parameter.name.elements) {
              if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken) throw new Error('Unsupported component props');
              const key = binding.propertyName?.getText(mod.source) ?? binding.name.text;
              if (Object.hasOwn(props, key)) env[binding.name.text] = props[key]!;
              else if (binding.initializer) env[binding.name.text] = value(binding.initializer, mod, env);
              else throw new Error(`Missing preview prop ${key} for ${name}`);
            }
          }
          let body: ts.Expression | undefined;
          if (ts.isBlock(fn.body)) {
            for (const statement of fn.body.statements) {
              if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer) env[declaration.name.text] = value(declaration.initializer, mod, env);
                else throw new Error('Unsupported local binding');
              }
              else if (ts.isReturnStatement(statement)) body = statement.expression;
              else throw new Error('Component execution needs a saved preview choice');
            }
          } else body = fn.body;
          if (!body) throw new Error(`No static return in ${name}`);
          return renderExpression(body, mod, env, `${path}/root`);
        } finally { stack.pop(); }
      }
      function renderExpression(expression: ts.Expression, mod: Module, env: Record<string, Value>, path: string): DesignNode[] {
        if (ts.isParenthesizedExpression(expression)) return renderExpression(expression.expression, mod, env, path);
        if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) return renderJsx(expression, mod, env, path);
        if (ts.isJsxFragment(expression)) return children(expression.children, mod, env, path);
        const literal = value(expression, mod, env);
        if (Array.isArray(literal)) return literal;
        if (literal === null || typeof literal === 'boolean') return [];
        if (typeof literal === 'object') throw new Error('Object is not a JSX child');
        return [{ id: nodeId(mod.source.fileName, path), kind: 'text', text: String(literal) }];
      }
      function children(items: ts.NodeArray<ts.JsxChild>, mod: Module, env: Record<string, Value>, path: string): DesignNode[] {
        const output: DesignNode[] = [];
        let index = 0;
        for (const child of items) {
          if (ts.isJsxText(child)) {
            // JSX strips indentation on newlines, preserving explicit single-line spaces.
            const lines = child.text.replace(/\r/g, '').split('\n');
            const text = lines.map((line, i) => { let result = line.replace(/\t/g, ' '); if (i > 0) result = result.trimStart(); if (i < lines.length - 1) result = result.trimEnd(); return result; }).filter((line) => line !== '').join(' ');
            if (!text) continue;
            output.push({ id: nodeId(mod.source.fileName, `${path}/${index++}`), kind: 'text', text: jsxText(text) });
          } else if (ts.isJsxExpression(child)) {
            if (child.expression) output.push(...renderExpression(child.expression, mod, env, `${path}/${index++}`));
          } else output.push(...renderExpression(child, mod, env, `${path}/${index++}`));
        }
        return output;
      }
      function renderJsx(jsx: ts.JsxElement | ts.JsxSelfClosingElement, mod: Module, env: Record<string, Value>, path: string): DesignNode[] {
        const opening = ts.isJsxElement(jsx) ? jsx.openingElement : jsx;
        const tag = opening.tagName.getText(mod.source);
        const props: Record<string, Value> = {};
        for (const attribute of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) throw new Error('JSX spreads need a preview choice');
          const name = attribute.name.getText(mod.source);
          if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Reserved JSX attribute');
          if (/^on[A-Z]/.test(name) || name === 'key' || name === 'ref') continue;
          if (!attribute.initializer) props[name] = true;
          else if (ts.isStringLiteral(attribute.initializer)) props[name] = jsxText(attribute.initializer.text);
          else if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) props[name] = value(attribute.initializer.expression, mod, env);
          else throw new Error('JSX attribute requires a static value');
        }
        const nodes = ts.isJsxElement(jsx) ? children(jsx.children, mod, env, `${path}/children`) : [];
        if (/^[A-Z]/.test(tag)) {
          props['children'] = nodes;
          const imported = mod.imports.get(tag);
          return imported ? renderComponent(resolveFile(project, mod.source.fileName, imported.file), imported.name, props, `${path}/${tag}`)
            : renderComponent(mod.source.fileName, tag, props, `${path}/${tag}`);
        }
        if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Unsupported JSX tag ${tag}`);
        const attrs: Record<string, string> = {};
        const id = nodeId(mod.source.fileName, path);
        for (const [name, literal] of Object.entries(props)) {
          if (name === 'style') {
            if (!literal || typeof literal !== 'object' || Array.isArray(literal)) throw new Error('Inline style must be an object');
            const style: StyleMap = {};
            for (const [property, val] of Object.entries(literal)) {
              if (typeof val !== 'string') throw new Error('Inline styles require explicit CSS string values');
              style[property.startsWith('--') ? property : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] = val;
            }
            inline.set(id, style);
          } else if (literal !== false && literal !== null) {
            if (typeof literal === 'object') throw new Error(`Non-scalar attribute ${name}`);
            attrs[name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name] = literal === true ? '' : String(literal);
          }
        }
        return [{ id, kind: 'element', tag, attrs, style: { base: {} }, children: nodes }];
      }
      // Layout styles load before the page's styles, as in an App Router source hierarchy.
      for (const layout of entry.layouts ?? []) module(layout);
      let nodes = renderComponent(entry.file, entry.exportName ?? 'default', {}, 'page');
      for (const [index, layout] of [...(entry.layouts ?? [])].reverse().entries()) {
        nodes = renderComponent(layout, 'default', { children: nodes }, `layout/${index}`);
      }
      const id = `page-${namespace}`;
      const root: ElementNode = { id: `s${namespace}`, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children: nodes };
      applyStyles(root, rules, inline);
      doc.pages[id] = { id, name: entry.route, route: entry.route, root };
      dependencies[id] = [...files].sort();
    } catch (error) { diagnostics.push({ file: currentFile, message: error instanceof Error ? error.message : 'Extraction failed' }); }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const invalid = validateDoc(doc);
  return invalid ? { ok: false, diagnostics: [{ file: '', message: invalid }] } : { ok: true, doc, dependencies };
}
