import ts from '@typescript/typescript6';
import { canonicalStringify, validateDoc, type ComponentDef, type DesignDoc, type DesignNode, type ElementNode, type InstanceNode, type NodeStyle, type StyleMap } from '@hub/design-model';
import { applyStyles, CssError, parseStyles, type Rule } from './css.js';
import type { ExtractOptions, ExtractResult, PreviewNode, RouteEntry, SourceDiagnostic, SourceProject } from './types.js';
import { choiceKey, choicesProblem, PreviewRequired } from './choices.js';
import { ADAPTERS_FILE, adaptersIssue, findAdapter, ignoresStyle, type Adapter } from './adapters.js';

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

/** The aliased target of a non-relative specifier, by longest matching prefix, or null. A prefix not ending in `/` matches whole segments. */
function aliased(project: SourceProject, specifier: string): string | null {
  let best: string | null = null;
  for (const prefix of Object.keys(project.aliases ?? {})) {
    const matches = specifier === prefix || specifier.startsWith(prefix) && (prefix.endsWith('/') || specifier[prefix.length] === '/');
    if (prefix && matches && (best === null || prefix.length > best.length)) best = prefix;
  }
  if (best === null) return null;
  const target = project.aliases![best]!;
  if (target.startsWith('/')) throw new Error(`Alias ${best} must map to a source-relative directory`);
  return `${target}/${specifier.slice(best.length)}`;
}

/** Relative and aliased specifiers are source files; any other specifier is an external package. */
function isSource(project: SourceProject, specifier: string): boolean {
  return specifier.startsWith('.') || aliased(project, specifier) !== null;
}

function resolveFile(project: SourceProject, from: string, specifier: string): string {
  const target = specifier.startsWith('.') ? null : aliased(project, specifier);
  if (!specifier.startsWith('.') && target === null) throw new Error(`External import ${specifier} needs a preview adapter`);
  const segments = target === null ? from.split('/').slice(0, -1) : [];
  for (const part of (target ?? specifier).split('/')) {
    if (part === '..') { if (!segments.length) throw new Error('Import escapes source root'); segments.pop(); }
    else if (part !== '.' && part !== '') segments.push(part);
  }
  const base = segments.join('/');
  const matches = [base, `${base}.tsx`, `${base}.jsx`, `${base}.ts`, `${base}.js`, `${base}/index.tsx`, `${base}/index.jsx`, `${base}/index.ts`, `${base}/index.js`]
    .filter((file) => Object.hasOwn(project.files, file));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous import ${specifier} from ${from}`);
  return matches[0]!;
}

// R5: the root layout's document shell is matched as html/body, then emitted as divs without document-only attributes.
const SHELL_TAGS = new Set(['html', 'body']);
const DOCUMENT_ATTRS = ['lang', 'xmlns', 'suppressHydrationWarning'];

class PropValue { constructor(readonly name: string) {} }
type Value = string | number | boolean | null | Record<string, unknown> | unknown[] | PropValue;
interface Module { source: ts.SourceFile; imports: Map<string, { file: string; name: string }>; styles: Map<string, string>; constants: Map<string, ts.Expression> }
interface Occurrence { instance: InstanceNode; component: string; label: string }

export function extractPages(project: SourceProject, entries: RouteEntry[], options: ExtractOptions = {}): ExtractResult {
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const dependencies: Record<string, string[]> = {};
  const diagnostics: SourceDiagnostic[] = [];
  const choiceError = options.choices ? choicesProblem(options.choices) : null;
  if (choiceError) return { ok: false, diagnostics: [{ file: '', message: choiceError }] };
  const adapterError = project.adapters !== undefined ? adaptersIssue(project.adapters) : null;
  if (adapterError) return { ok: false, diagnostics: [{ file: ADAPTERS_FILE, message: adapterError }] };
  const sampleArrays = new WeakSet<unknown[]>();
  function markSamples(value: unknown): void { if (Array.isArray(value)) { sampleArrays.add(value); value.forEach(markSamples); } else if (value && typeof value === 'object') Object.values(value).forEach(markSamples); }
  for (const choice of Object.values(options.choices ?? {})) if (choice.kind === 'value') markSamples(choice.value);
  const seenRoutes = new Set<string>();
  // Styles each shared definition computed at its first occurrence, with the rules responsible, across routes.
  const adopted = new Map<string, Map<string, { style: NodeStyle; rules: Rule[] }>>();
  for (const entry of [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0)) {
    let currentFile = entry.file;
    try {
      if (!entry.route.startsWith('/') || seenRoutes.has(entry.route)) throw new Error(`Invalid or duplicate route ${entry.route}`);
      seenRoutes.add(entry.route);
      if ([entry.file, ...(entry.layouts ?? [])].some((file) => file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.' || part === ''))) throw new Error('Source paths must be relative POSIX paths');
      const files = new Set<string>();
      const loadedStyles = new Set<string>();
      const modules = new Map<string, Module>();
      const rules: Rule[] = [];
      const inline = new Map<string, StyleMap>();
      const stack: string[] = [];
      const namespace = stableId(entry.route);
      let idNamespace = namespace;
      let declarations: ComponentDef['props'] | null = null;
      let requiredProps: Set<string> | null = null;
      const definitions: Record<string, ComponentDef> = {};
      const requirements = new Map<string, Set<string>>();
      const occurrences = new Map<ElementNode, Occurrence>();
      const layers: string[] = [];
      const nodeId = (file: string, path: string) => `s${stableId(`${idNamespace}:${file}:${path}`)}`;
      function reactHook(expression: ts.Expression, mod: Module, hook: string): boolean {
        if (ts.isIdentifier(expression)) { const imported=mod.imports.get(expression.text); return imported?.file==='react'&&imported.name===hook; }
        if (ts.isPropertyAccessExpression(expression)&&ts.isIdentifier(expression.expression)&&expression.name.text===hook) { const imported=mod.imports.get(expression.expression.text);return imported?.file==='react'&&(imported.name==='default'||imported.name==='*'); }
        return false;
      }
      function previewValue(expression: ts.Expression, mod: Module): Value {
        const code=expression.getText(mod.source),key=choiceKey(mod.source.fileName,code);
        const choice=options.choices?.[key];
        if(choice?.kind==='value')return choice.value;
        throw new PreviewRequired({key,file:mod.source.fileName,expression:code,kind:'value'});
      }
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
              const cssFile = resolveFile(project, file, specifier);
              if (ignoresStyle(project.adapters, cssFile)) {
                // Ruling A: an ignored stylesheet is neither parsed nor a dependency, so it cannot bind class names.
                if (statement.importClause) throw new Error(`Ignored stylesheet ${cssFile} cannot be imported with bindings`);
                continue;
              }
              files.add(cssFile);
              const scope = cssFile.endsWith('.module.css') ? `c${stableId(cssFile)}` : null;
              if (!loadedStyles.has(cssFile)) {
                currentFile = cssFile;
                loadedStyles.add(cssFile);
                // A stylesheet reached from both TSX and @import is bundled once, at its first occurrence.
                rules.push(...parseStyles(project.files[cssFile]!, scope, { file: cssFile, layers, resolveImport(spec, from) {
                  const imported = resolveFile(project, from, spec);
                  if (!imported.endsWith('.css') || imported.endsWith('.module.css')) throw new Error(`Unsupported CSS @import ${spec}`);
                  if (ignoresStyle(project.adapters, imported)) return { file: imported, text: '' };
                  files.add(imported);
                  if (loadedStyles.has(imported)) return { file: imported, text: '' };
                  loadedStyles.add(imported); return { file: imported, text: project.files[imported]! };
                } }).rules);
                currentFile = file;
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
              if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) mod.imports.set(clause.namedBindings.name.text,{file:specifier,name:'*'});
              const runtime=clause.name||clause.namedBindings&&(!ts.isNamedImports(clause.namedBindings)||clause.namedBindings.elements.some(binding=>!binding.isTypeOnly));
              if(runtime&&isSource(project,specifier)) { module(resolveFile(project,file,specifier)); currentFile=file; }
            } else if (!statement.importClause) throw new Error(`Side-effect import ${specifier} needs a preview adapter`);
          }
          if(ts.isExpressionStatement(statement)&&!ts.isStringLiteral(statement.expression))throw new Error('Module side effects need an explicit preview adapter');
          if(ts.isExportDeclaration(statement)&&!statement.isTypeOnly&&statement.moduleSpecifier&&ts.isStringLiteral(statement.moduleSpecifier)&&isSource(project,statement.moduleSpecifier.text)) {
            const runtime=!statement.exportClause||!ts.isNamedExports(statement.exportClause)||statement.exportClause.elements.some(binding=>!binding.isTypeOnly);
            if(runtime){module(resolveFile(project,file,statement.moduleSpecifier.text));currentFile=file;}
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
          const imported=mod.imports.get(expression.text);
          if(imported&&isSource(project,imported.file)) {
            const target=module(resolveFile(project,mod.source.fileName,imported.file));
            const exported=target.constants.get(imported.name);
            if(exported)return value(exported,target,{},depth+1);
            if(imported.name==='default')for(const statement of target.source.statements)if(ts.isExportAssignment(statement))return value(statement.expression,target,{},depth+1);
          }
        }
        if (ts.isPropertyAccessExpression(expression)) {
          if (ts.isIdentifier(expression.expression)) {
            const scope = mod.styles.get(expression.expression.text);
            if (scope) return `${scope}__${expression.name.text}`;
          }
          const object = value(expression.expression, mod, env, depth + 1);
          if (object instanceof PropValue) throw new Error('Object preview props need a saved adapter');
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
        if (ts.isArrayLiteralExpression(expression)) {
          if(expression.elements.some((item)=>ts.isOmittedExpression(item)||ts.isSpreadElement(item)))throw new Error('Sparse or spread source arrays need a preview adapter');
          const result=expression.elements.map((item)=>value(item,mod,env,depth+1));sampleArrays.add(result);return result;
        }
        const code = expression.getText(mod.source);
        const key = choiceKey(mod.source.fileName,code);
        const chosen = options.choices?.[key];
        if (chosen?.kind === 'value') return chosen.value;
        throw new PreviewRequired({ key, file: mod.source.fileName, expression: code, kind: 'value' });
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
              if(/^on[A-Z]/.test(key))continue; // callback-only props do not affect a static preview unless read elsewhere
              if (declarations && key !== 'children') {
                if (!Object.hasOwn(props, key) && !binding.initializer) throw new Error(`Missing preview prop ${key} for ${name}`);
                if (binding.initializer) requiredProps?.delete(key);
                else requiredProps?.add(key);
                const defaultValue = binding.initializer ? value(binding.initializer, mod, env) : '';
                if (typeof defaultValue !== 'string') throw new Error('Shared component defaults must be strings');
                declarations[key] = { default: defaultValue };
                env[binding.name.text] = new PropValue(key);
              }
              else if (Object.hasOwn(props, key)) env[binding.name.text] = props[key]!;
              else if (binding.initializer) env[binding.name.text] = value(binding.initializer, mod, env);
              else throw new Error(`Missing preview prop ${key} for ${name}`);
            }
          }
          let body: ts.Expression | undefined;
          if (ts.isBlock(fn.body)) {
            for (const statement of fn.body.statements) {
              if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer) env[declaration.name.text] = value(declaration.initializer, mod, env);
                else if (ts.isArrayBindingPattern(declaration.name)&&declaration.initializer&&ts.isCallExpression(declaration.initializer)&&reactHook(declaration.initializer.expression,mod,'useState')) {
                  const first=declaration.name.elements[0];
                  if(!first||!ts.isBindingElement(first)||!ts.isIdentifier(first.name)||first.dotDotDotToken||declaration.name.elements.length>2)throw new Error('Unsupported state binding');
                  env[first.name.text]=previewValue(declaration.initializer,mod);
                }
                else throw new Error('Unsupported local binding');
              }
              else if (ts.isReturnStatement(statement)) body = statement.expression;
              else if (ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&(reactHook(statement.expression.expression,mod,'useEffect')||reactHook(statement.expression.expression,mod,'useLayoutEffect'))) {
                if(previewValue(statement.expression,mod)!==null)throw new Error('Effect preview choices must be null: effects are never executed');
              }
              else throw new Error('Component execution needs a saved preview choice');
            }
          } else body = fn.body;
          if (!body) throw new Error(`No static return in ${name}`);
          return renderExpression(body, mod, env, `${path}/root`);
        } finally { stack.pop(); }
      }
      function renderExpression(expression: ts.Expression, mod: Module, env: Record<string, Value>, path: string): DesignNode[] {
        if (ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isSatisfiesExpression(expression)) return renderExpression(expression.expression, mod, env, path);
        if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression)) return renderJsx(expression, mod, env, path);
        if (ts.isJsxFragment(expression)) return children(expression.children, mod, env, path);
        if(ts.isConditionalExpression(expression)) {
          const condition=value(expression.condition,mod,env);
          if(condition instanceof PropValue)throw new Error('Prop-dependent shared branches need a preview adapter');
          return renderExpression(condition?expression.whenTrue:expression.whenFalse,mod,env,`${path}/${condition?'then':'else'}`);
        }
        if(ts.isBinaryExpression(expression)&&(expression.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken||expression.operatorToken.kind===ts.SyntaxKind.BarBarToken)) {
          const left=value(expression.left,mod,env);
          if(left instanceof PropValue)throw new Error('Prop-dependent shared branches need a preview adapter');
          const right=expression.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken?!!left:!left;
          return renderExpression(right?expression.right:expression.left,mod,env,`${path}/${right?'right':'left'}`);
        }
        if(ts.isCallExpression(expression)&&ts.isPropertyAccessExpression(expression.expression)&&expression.expression.name.text==='map') {
          const callback=expression.arguments[0];
          if(expression.arguments.length!==1||!callback||!(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))||callback.parameters.length>3||callback.parameters.some(parameter=>parameter.dotDotDotToken||parameter.initializer))throw new Error('Map previews require one inline arrow/function template with plain parameters');
          const rows=value(expression.expression.expression,mod,env);
          if(!Array.isArray(rows)||rows.length>200)throw new Error('Map previews require an array of at most 200 sample rows');
          let template:ts.Expression|undefined;
          if(ts.isBlock(callback.body)) { if(callback.body.statements.length===1&&ts.isReturnStatement(callback.body.statements[0]!))template=callback.body.statements[0]!.expression; }
          else template=callback.body;
          if(!template)throw new Error('Map templates must return static JSX without executing statements');
          return rows.flatMap((row,index)=>{
            const scope={...env};
            for(const [position,parameter]of callback.parameters.entries()) {
              const item=position===0?row:position===1?index:rows;
              if(ts.isIdentifier(parameter.name))scope[parameter.name.text]=item as Value;
              else if(position===0&&ts.isObjectBindingPattern(parameter.name))for(const binding of parameter.name.elements) {
                if(!ts.isIdentifier(binding.name)||binding.dotDotDotToken||!item||typeof item!=='object'||Array.isArray(item))throw new Error('Unsupported map row binding');
                const key=binding.propertyName?.getText(mod.source)??binding.name.text;
                if(!Object.hasOwn(item,key))throw new Error(`Missing sample row field ${key}`);
                scope[binding.name.text]=(item as Record<string,Value>)[key]!;
              }
              else throw new Error('Unsupported map parameters');
            }
            let root=template!;while(ts.isParenthesizedExpression(root))root=root.expression;
            const opening=ts.isJsxElement(root)?root.openingElement:ts.isJsxSelfClosingElement(root)?root:null;
            const keyAttr=opening?.attributes.properties.find((attribute)=>ts.isJsxAttribute(attribute)&&attribute.name.getText(mod.source)==='key');
            let identity=String(index);
            if(keyAttr&&ts.isJsxAttribute(keyAttr)&&keyAttr.initializer) {
              const keyValue=ts.isStringLiteral(keyAttr.initializer)?keyAttr.initializer.text:ts.isJsxExpression(keyAttr.initializer)&&keyAttr.initializer.expression?value(keyAttr.initializer.expression,mod,scope):null;
              if(typeof keyValue!=='string'&&typeof keyValue!=='number')throw new Error('Map keys require a static string or number');
              identity=`key-${stableId(String(keyValue))}`;
            }
            return renderExpression(template!,mod,scope,`${path}/map/${identity}`);
          });
        }
        const code = expression.getText(mod.source);
        const key = choiceKey(mod.source.fileName,code);
        const choice = options.choices?.[key];
        function sampledNodes(): DesignNode[] {
          if (choice?.kind !== 'nodes') throw new PreviewRequired({ key, file: mod.source.fileName, expression: code, kind: 'nodes' });
          function sample(item: PreviewNode | string, at: string): DesignNode {
            const id = nodeId(mod.source.fileName,at);
            if (declarations && /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(JSON.stringify(item))) throw new Error('Literal placeholder syntax in shared preview samples needs an adapter');
            if (typeof item === 'string') return { id, kind: 'text', text: item };
            if (!item || typeof item !== 'object' || typeof item.tag !== 'string' || (item.children !== undefined && !Array.isArray(item.children))) throw new Error('Invalid preview node');
            if (item.style) inline.set(id,structuredClone(item.style));
            return { id, kind: 'element', tag: item.tag, attrs: structuredClone(item.attrs ?? {}), style: { base: {} }, children: (item.children ?? []).map((child,index) => sample(child,`${at}/${index}`)) };
          }
          return choice.nodes.map((item,index) => sample(item,`${path}/preview/${index}`));
        }
        let literal: Value;
        try { literal = value(expression, mod, env); }
        catch (error) { if (error instanceof PreviewRequired && error.gap.key === key) return sampledNodes(); throw error; }
        if (literal instanceof PropValue) return [{ id: nodeId(mod.source.fileName, path), kind: 'text', text: `{{${literal.name}}}` }];
        if (declarations && typeof literal === 'string' && /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(literal)) throw new Error('Literal placeholder syntax in shared components needs an adapter');
        if (Array.isArray(literal)) { if (sampleArrays.has(literal)) return sampledNodes(); return literal as DesignNode[]; }
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
            if (declarations && /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(text)) throw new Error('Literal placeholder syntax in shared components needs an adapter');
            output.push({ id: nodeId(mod.source.fileName, `${path}/${index++}`), kind: 'text', text: jsxText(text) });
          } else if (ts.isJsxExpression(child)) {
            if (child.expression) output.push(...renderExpression(child.expression, mod, env, `${path}/${index++}`));
          } else output.push(...renderExpression(child, mod, env, `${path}/${index++}`));
        }
        return output;
      }
      /** The adapter for a tag bound to an external import, or null for source and host tags. Unmapped imports fail. */
      function adapterFor(tag: string, mod: Module): Adapter | null {
        const [head, ...members] = tag.split('.');
        const imported = mod.imports.get(head!);
        if (!imported || isSource(project, imported.file)) return null;
        if (members.length > 1 || (members.length === 1 && imported.name !== '*')) throw new Error(`Unsupported JSX member tag ${tag} from ${imported.file}; only <Namespace.Export> of a namespace import is supported`);
        if (!members.length && imported.name === '*') throw new Error(`Namespace import ${tag} from ${imported.file} cannot be a JSX tag`);
        const adapter = findAdapter(project.adapters, imported.file, members[0] ?? imported.name);
        if (!adapter) throw new Error(`External import ${imported.file} needs a preview adapter`);
        return adapter;
      }
      function renderJsx(jsx: ts.JsxElement | ts.JsxSelfClosingElement, mod: Module, env: Record<string, Value>, path: string): DesignNode[] {
        const opening = ts.isJsxElement(jsx) ? jsx.openingElement : jsx;
        let tag = opening.tagName.getText(mod.source);
        if (SHELL_TAGS.has(tag) && (declarations || mod.source.fileName !== entry.layouts?.[0])) throw new Error(`<${tag}> is only supported as the root layout's document shell`);
        const adapter = /^[A-Z]/.test(tag) ? adapterFor(tag, mod) : null;
        if (adapter?.kind === 'omit') return [];
        // An adapter reads only className/class and its mapped props. Every other prop is ignored and never evaluated.
        const mapped = adapter?.kind === 'element' ? adapter.attrs ?? {} : null;
        const reads = (name: string) => !adapter || (mapped !== null && (name === 'className' || name === 'class' || Object.hasOwn(mapped, name)));
        let props: Record<string, Value> = {};
        for (const attribute of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) { if (adapter?.kind === 'children') continue; throw new Error('JSX spreads need a preview choice'); }
          const name = attribute.name.getText(mod.source);
          if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Reserved JSX attribute');
          if (/^on[A-Z]/.test(name) || name === 'key' || name === 'ref' || !reads(name)) continue;
          if (!attribute.initializer) props[name] = true;
          else if (ts.isStringLiteral(attribute.initializer)) props[name] = jsxText(attribute.initializer.text);
          else if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) props[name] = value(attribute.initializer.expression, mod, env);
          else throw new Error('JSX attribute requires a static value');
          if (declarations && typeof props[name] === 'string' && /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(props[name])) throw new Error('Literal placeholder syntax in shared components needs an adapter');
        }
        const nodes = ts.isJsxElement(jsx) ? children(jsx.children, mod, env, `${path}/children`) : [];
        if (adapter?.kind === 'children') return nodes;
        if (adapter?.kind === 'element') {
          // A plain host element, never a shared component: class compiles as on any host tag, mapped props become attributes.
          const host: Record<string, Value> = {};
          for (const [name, item] of Object.entries(props)) host[name === 'className' || name === 'class' ? name : mapped![name]!] = item;
          tag = adapter.tag;
          props = host;
        }
        if (/^[A-Z]/.test(tag)) {
          props['children'] = nodes;
          const imported = mod.imports.get(tag);
          if (options.sharedComponents) {
            if (nodes.length) throw new Error('Shared component children slots need a saved preview adapter');
            const file = imported ? resolveFile(project, mod.source.fileName, imported.file) : mod.source.fileName;
            const exportName = imported?.name ?? tag;
            const component = `C${stableId(`${file}:${exportName}`)}`;
            const passed: Record<string, string> = {};
            for (const [key, item] of Object.entries(props)) {
              if (key === 'children') continue;
              if (!(typeof item === 'string' || item instanceof PropValue)) throw new Error('Shared component preview props must be strings');
              passed[key] = item instanceof PropValue ? `{{${item.name}}}` : item;
            }
            if (!Object.hasOwn(definitions, component)) {
              const oldNamespace = idNamespace, oldDeclarations = declarations, oldRequired = requiredProps;
              idNamespace = component;
              const declared = Object.fromEntries(Object.keys(passed).map((key) => [key, { default: '' }]));
              declarations = declared;
              const required = new Set(Object.keys(passed));
              requiredProps = required;
              try {
                const symbolic = Object.fromEntries(Object.keys(passed).map((key) => [key, new PropValue(key)]));
                const rendered = renderComponent(file, exportName, { ...symbolic, children: [] }, 'definition');
                if (rendered.length !== 1 || rendered[0]?.kind !== 'element') throw new Error('Shared components require one element root');
                definitions[component] = { name: component, props: declared, root: rendered[0] };
                requirements.set(component, required);
              } finally { idNamespace = oldNamespace; declarations = oldDeclarations; requiredProps = oldRequired; }
            }
            for (const key of requirements.get(component) ?? []) if (!Object.hasOwn(passed, key)) throw new Error(`Missing preview prop ${key} for ${tag}`);
            const instance: InstanceNode = { id: nodeId(mod.source.fileName, path), kind: 'instance', component, props: passed, style: { base: {} } };
            if (declarations) return [instance];
            // R3: style the occurrence expanded in its real context; it becomes an instance afterwards.
            const expanded = renderComponent(file, exportName, props, `${path}/${tag}`);
            if (expanded.length !== 1 || expanded[0]?.kind !== 'element') throw new Error('Shared components require one element root');
            occurrences.set(expanded[0], { instance, component, label: `${exportName} in ${file}` });
            return expanded;
          }
          return imported ? renderComponent(resolveFile(project, mod.source.fileName, imported.file), imported.name, props, `${path}/${tag}`)
            : renderComponent(mod.source.fileName, tag, props, `${path}/${tag}`);
        }
        if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Unsupported JSX tag ${tag}`);
        const attrs: Record<string, string> = {};
        const id = nodeId(mod.source.fileName, path);
        for (const [name, literal] of Object.entries(props)) {
          if (literal instanceof PropValue) {
            if (name === 'style' || name === 'className') throw new Error('Prop-driven CSS needs a saved preview adapter');
            attrs[name === 'htmlFor' ? 'for' : name] = `{{${literal.name}}}`;
            continue;
          }
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
      const first = nodes[0];
      const expanded: ElementNode = nodes.length === 1 && first?.kind === 'element' ? first
        : { id: `s${namespace}`, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children: nodes };
      const matched = new Map<ElementNode, Rule[]>();
      // R5: html may only be the page root and body only its child, both from the root layout.
      (function shell(node: ElementNode, parent: ElementNode | null): void {
        if (node.tag === 'html' && (parent || expanded !== first || occurrences.has(node)) || node.tag === 'body' && parent?.tag !== 'html') {
          currentFile = entry.layouts?.[0] ?? entry.file;
          throw new Error(`<${node.tag}> is only supported as the root layout's document shell`);
        }
        for (const child of node.children) if (child.kind === 'element') shell(child, node);
      })(expanded, null);
      applyStyles(expanded, rules, inline, { wrapper: expanded !== first, matched });
      // Selectors saw the real document; the model forbids document tags, so the shell becomes divs.
      for (const node of expanded.tag === 'html' ? [expanded, ...expanded.children] : []) {
        if (node.kind !== 'element' || !SHELL_TAGS.has(node.tag)) continue;
        node.tag = 'div';
        for (const name of DOCUMENT_ATTRS) delete node.attrs[name];
      }
      const styled = new Set<string>();
      function adopt(node: ElementNode, { component, label }: Occurrence): void {
        const styles = new Map<string, { style: NodeStyle; rules: Rule[] }>();
        const definition = definitions[component]!;
        function align(def: DesignNode, occurrence: DesignNode): void {
          const nested = occurrence.kind === 'element' ? occurrences.get(occurrence) : undefined;
          if (def.kind === 'instance' && nested?.component === def.component) return adopt(occurrence as ElementNode, nested);
          if (def.kind !== occurrence.kind || def.kind === 'instance' || (def.kind === 'element' && occurrence.kind === 'element' && (def.tag !== occurrence.tag || def.children.length !== occurrence.children.length))) {
            throw new Error(`Shared component ${label} renders a different structure per occurrence; provide a preview adapter`);
          }
          if (def.kind !== 'element' || occurrence.kind !== 'element') return;
          styles.set(def.id, { style: occurrence.style, rules: matched.get(occurrence) ?? [] });
          def.children.forEach((child, index) => align(child, occurrence.children[index]!));
        }
        align(definition.root, node);
        const first = adopted.get(component);
        if (first) for (const [id, now] of styles) {
          const before = first.get(id)!;
          if (canonicalStringify(before.style) === canonicalStringify(now.style)) continue;
          const key = (rule: Rule) => `${rule.text} (${rule.file})`;
          const was = new Set(before.rules.map(key)), is = new Set(now.rules.map(key));
          const responsible = [...was, ...is].filter((item) => !was.has(item) || !is.has(item));
          const message = `Shared component ${label} has context-dependent CSS: ${responsible.join(', ') || 'inline styles'} match only some occurrences; provide a preview adapter`;
          const rule = [...before.rules, ...now.rules].find((item) => responsible.includes(key(item)));
          throw rule ? new CssError(rule.file, message) : new Error(message);
        }
        else adopted.set(component, styles);
        function apply(def: DesignNode): void {
          if (def.kind !== 'element') return;
          def.style = structuredClone(styles.get(def.id)!.style);
          delete def.attrs['class'];
          def.children.forEach(apply);
        }
        apply(definition.root);
        styled.add(component);
      }
      function collapse(node: ElementNode): void {
        node.children = node.children.map((child) => {
          const occurrence = child.kind === 'element' ? occurrences.get(child) : undefined;
          if (!occurrence) { if (child.kind === 'element') collapse(child); return child; }
          adopt(child as ElementNode, occurrence);
          return occurrence.instance;
        });
      }
      const top = occurrences.get(expanded);
      if (top) adopt(expanded, top); else collapse(expanded);
      const root: ElementNode = top ? { id: `s${namespace}`, kind: 'element', tag: 'div', attrs: {}, style: { base: {} }, children: [top.instance] } : expanded;
      for (const [name, definition] of Object.entries(definitions)) {
        if (!styled.has(name)) throw new Error(`Shared component ${name} has no rendered occurrence to style`);
        const existing = doc.components[name];
        if (existing && canonicalStringify(existing) !== canonicalStringify(definition)) throw new Error(`Shared component ${name} has route-dependent props or CSS; provide an explicit preview adapter`);
        doc.components[name] = definition;
      }
      doc.pages[id] = { id, name: entry.route, route: entry.route, root };
      dependencies[id] = [...files].sort();
    } catch (error) { diagnostics.push({ file: error instanceof PreviewRequired ? error.gap.file : error instanceof CssError ? error.file : currentFile, message: error instanceof Error ? error.message : 'Extraction failed', ...(error instanceof PreviewRequired ? { gap: error.gap } : {}) }); }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const invalid = validateDoc(doc);
  return invalid ? { ok: false, diagnostics: [{ file: '', message: invalid }] } : { ok: true, doc, dependencies };
}
