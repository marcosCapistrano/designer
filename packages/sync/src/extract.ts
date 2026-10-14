import ts from '@typescript/typescript6';
import { canonicalStringify, validateDoc, type ComponentDef, type DesignDoc, type DesignNode, type ElementNode, type InstanceNode, type NodeStyle, type StyleMap } from '@hub/design-model';
import { applyStyles, CssError, parseStyles, winningTokens, type Rule, type Token } from './css.js';
import { mergeTokens } from './tokens.js';
import type { ExtractOptions, ExtractResult, InlinedComponent, InlineReason, PreviewNode, RouteEntry, RouteInlining, SourceDiagnostic, SourceProject, TokenSource } from './types.js';
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
type Value = string | number | boolean | null | undefined | Record<string, unknown> | unknown[] | PropValue;
/** A local binding evaluated on first use, so a gap arises only for values the preview actually renders. */
class Lazy {
  private state: 'idle' | 'busy' | 'done' = 'idle';
  private result: Value = null;
  constructor(private readonly compute: () => Value) {}
  get(): Value {
    if (this.state === 'done') return this.result;
    if (this.state === 'busy') throw new Error('Cyclic local binding');
    this.state = 'busy';
    try { this.result = this.compute(); this.state = 'done'; return this.result; }
    finally { if (this.state === 'busy') this.state = 'idle'; }
  }
}
type Env = Record<string, Value | Lazy>;
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/** CSS that depends on a shared definition's prop. Ruling F: the definition being rendered is inlined instead. */
class PropDrivenCss extends Error { constructor() { super('Prop-driven CSS needs a saved preview adapter'); } }
/** Ruling G: a definition reads a destructured prop without a default that its occurrence omits. */
class OmittedProp extends Error {}
const RANK: Record<InlineReason, number> = { children: 0, 'optional-prop': 1, 'prop-css': 2 };
/** The reason reported for a component inlined for several reasons, independent of route and cache order. */
export function strongerReason(a: InlineReason | undefined, b: InlineReason): InlineReason { return a !== undefined && RANK[a] >= RANK[b] ? a : b; }
/** A component found to need inlining (Ruling F); the route is rendered again with it inlined. */
class Inline extends Error { constructor(readonly key: string, readonly reason: InlineReason) { super(`Inline ${key} (${reason})`); } }

/** Decision 1: `clsx` from the module "clsx" is the only built-in function, with the library's semantics. */
function classList(item: unknown): string {
  if (item instanceof PropValue) throw new PropDrivenCss();
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (Array.isArray(item)) return item.filter(Boolean).map(classList).filter(Boolean).join(' ');
  if (item && typeof item === 'object') return Object.entries(item).filter(([, on]) => {
    if (on instanceof PropValue) throw new PropDrivenCss();
    return Boolean(on);
  }).map(([name]) => name).join(' ');
  return '';
}
interface Module { source: ts.SourceFile; imports: Map<string, { file: string; name: string }>; styles: Map<string, string>; constants: Map<string, ts.Expression> }
interface Occurrence { instance: InstanceNode; component: string; label: string }

/** The name a source component is known by: its export name, or a default export's declared name, else its file. */
function componentName(project: SourceProject, file: string, exportName: string): string {
  if (exportName !== 'default') return exportName;
  const source = ts.createSourceFile(file, project.files[file] ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return statement.name.text;
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) return statement.expression.text;
  }
  const parts = file.split('/');
  const base = parts.at(-1)!.replace(/\.[jt]sx?$/, '');
  return base === 'index' && parts.length > 1 ? parts.at(-2)! : base;
}

/**
 * Ruling F: in shared mode, a component whose occurrences pass children or className/style, or whose definition has
 * prop-driven CSS, is expanded in place at every occurrence. Inlining one component can expose another, so extraction
 * repeats until no route rendered a component that became inlined after that route was extracted.
 */
export function extractPages(project: SourceProject, entries: RouteEntry[], options: ExtractOptions = {}): ExtractResult {
  const inlineSet = new Map<string, InlineReason>();
  for (const [key, reason] of Object.entries(options.inline ?? {})) {
    if (!/^[^:]+:[^:]+$/.test(key) || !Object.hasOwn(RANK, reason)) return { ok: false, diagnostics: [{ file: '', message: `Invalid inline component ${key}` }] };
    inlineSet.set(key, reason);
  }
  for (;;) {
    const run = extractOnce(project, entries, options, inlineSet);
    if (run) return run;
  }
}

function extractOnce(project: SourceProject, entries: RouteEntry[], options: ExtractOptions, inlineSet: Map<string, InlineReason>): ExtractResult | null {
  const doc: DesignDoc = { meta: { version: 1, seq: 0 }, pages: {}, components: {}, tokens: {} };
  const dependencies: Record<string, string[]> = {};
  const routeTokens: Record<string, TokenSource[]> = {};
  const tokenOrigins = new Map<string, TokenSource>();
  const diagnostics: SourceDiagnostic[] = [];
  const choiceError = options.choices ? choicesProblem(options.choices) : null;
  if (choiceError) return { ok: false, diagnostics: [{ file: '', message: choiceError }] };
  const adapterError = project.adapters !== undefined ? adaptersIssue(project.adapters) : null;
  if (adapterError) return { ok: false, diagnostics: [{ file: ADAPTERS_FILE, message: adapterError }] };
  const sampleArrays = new WeakSet<unknown[]>();
  function markSamples(value: unknown): void { if (Array.isArray(value)) { sampleArrays.add(value); value.forEach(markSamples); } else if (value && typeof value === 'object') Object.values(value).forEach(markSamples); }
  for (const choice of Object.values(options.choices ?? {})) if (choice.kind === 'value') markSamples(choice.value);
  const names = new Map<string, string>();
  const nameOf = (key: string): string => {
    let name = names.get(key);
    if (name === undefined) { const at = key.lastIndexOf(':'); name = componentName(project, key.slice(0, at), key.slice(at + 1)); names.set(key, name); }
    return name;
  };
  // What each route rendered, and which components were already inlined when it last rendered.
  const rendered: { entry: RouteEntry; id: string; encountered: Set<string>; known: Set<string>; reasons: Map<string, InlineReason> }[] = [];
  // Styles each shared definition computed at its first occurrence, with the rules responsible, across routes.
  const adopted = new Map<string, Map<string, { style: NodeStyle; rules: Rule[] }>>();
  const sorted = [...entries].sort((a, b) => a.route < b.route ? -1 : a.route > b.route ? 1 : 0);
  for (let index = 0; index < sorted.length; index++) {
    const entry = sorted[index]!;
    const encountered = new Set<string>(), known = new Set(inlineSet.keys());
    // Every reason this route gives for inlining each component, found at every occurrence even once it is inlined.
    const reasons = new Map<string, InlineReason>(), tried = new Set<string>();
    const note = (key: string, reason: InlineReason) => reasons.set(key, strongerReason(reasons.get(key), reason));
    let currentFile = entry.file;
    try {
      if (!entry.route.startsWith('/') || (index > 0 && sorted[index - 1]!.route === entry.route)) throw new Error(`Invalid or duplicate route ${entry.route}`);
      if ([entry.file, ...(entry.layouts ?? [])].some((file) => file.startsWith('/') || file.split('/').some((part) => part === '..' || part === '.' || part === ''))) throw new Error('Source paths must be relative POSIX paths');
      const files = new Set<string>();
      const loadedStyles = new Set<string>();
      const modules = new Map<string, Module>();
      const rules: Rule[] = [];
      const tokens: Token[] = [];
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
      function chosenValue(file: string, code: string): Value {
        const key=choiceKey(file,code);
        const choice=options.choices?.[key];
        if(choice?.kind==='value')return choice.value;
        throw new PreviewRequired({key,file,expression:code,kind:'value'});
      }
      function previewValue(expression: ts.Expression, mod: Module): Value { return chosenValue(mod.source.fileName, expression.getText(mod.source)); }
      // Decision 3: props of a page/layout entry that the importer does not supply come from the entry file's `props.<name>` choice.
      const entryProps = new WeakMap<object, string>();
      const entryProp = (file: string, name: string): Value => chosenValue(file, `props.${name}`);
      /** True for a member access rooted at the global `process`, which is never read: the whole access is a gap. */
      function globalProcess(expression: ts.Expression, mod: Module, env: Env): boolean {
        let root = expression;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        return ts.isIdentifier(root) && root.text === 'process' && !Object.hasOwn(env, 'process') && !mod.constants.has('process') && !mod.imports.has('process');
      }
      function isClsx(callee: ts.Expression, mod: Module, env: Env): boolean {
        if (!ts.isIdentifier(callee) || Object.hasOwn(env, callee.text) || mod.constants.has(callee.text)) return false;
        const imported = mod.imports.get(callee.text);
        return imported?.file === 'clsx' && (imported.name === 'clsx' || imported.name === 'default');
      }
      const lookup = (object: Record<string, unknown>, key: string): Value => object[key] as Value;
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
                const parsed = parseStyles(project.files[cssFile]!, scope, { file: cssFile, layers, resolveImport(spec, from) {
                  const imported = resolveFile(project, from, spec);
                  if (!imported.endsWith('.css') || imported.endsWith('.module.css')) throw new Error(`Unsupported CSS @import ${spec}`);
                  if (ignoresStyle(project.adapters, imported)) return { file: imported, text: '' };
                  files.add(imported);
                  if (loadedStyles.has(imported)) return { file: imported, text: '' };
                  loadedStyles.add(imported); return { file: imported, text: project.files[imported]! };
                } });
                rules.push(...parsed.rules);
                tokens.push(...parsed.tokens);
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
      function value(expression: ts.Expression, mod: Module, env: Env, depth = 0): Value {
        if (depth > 30) throw new Error('Cyclic or deeply nested constant');
        // Decision 2: `await x` is the value of x; a Promise prop is modeled by its resolved value.
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression)) return value(expression.expression, mod, env, depth + 1);
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
        if (ts.isNumericLiteral(expression)) return Number(expression.text);
        if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
        if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
        if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
        if (ts.isIdentifier(expression)) {
          if (Object.hasOwn(env, expression.text)) { const bound = env[expression.text]; return bound instanceof Lazy ? bound.get() : bound; }
          const constant = mod.constants.get(expression.text);
          if (constant) return value(constant, mod, env, depth + 1);
          const imported=mod.imports.get(expression.text);
          if(imported&&isSource(project,imported.file)) {
            const target=module(resolveFile(project,mod.source.fileName,imported.file));
            const exported=target.constants.get(imported.name);
            if(exported)return value(exported,target,{},depth+1);
            if(imported.name==='default')for(const statement of target.source.statements)if(ts.isExportAssignment(statement))return value(statement.expression,target,{},depth+1);
          }
          if (expression.text === 'undefined' && !imported) return undefined;
        }
        if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && globalProcess(expression, mod, env)) return previewValue(expression, mod);
        if (ts.isPropertyAccessExpression(expression)) {
          if (ts.isIdentifier(expression.expression)) {
            const scope = mod.styles.get(expression.expression.text);
            if (scope) return `${scope}__${expression.name.text}`;
          }
          const object = value(expression.expression, mod, env, depth + 1);
          if (object instanceof PropValue) throw new Error('Object preview props need a saved adapter');
          if (expression.questionDotToken && (object === null || object === undefined)) return undefined;
          if (object && typeof object === 'object' && !Array.isArray(object) && Object.hasOwn(object, expression.name.text)) return lookup(object, expression.name.text);
          if (object && typeof object === 'object' && entryProps.has(object)) return entryProp(entryProps.get(object)!, expression.name.text);
        }
        if (ts.isElementAccessExpression(expression)) {
          const object = value(expression.expression, mod, env, depth + 1);
          const key = value(expression.argumentExpression, mod, env, depth + 1);
          if (object instanceof PropValue || key instanceof PropValue) throw new Error('Prop-dependent lookups need a preview adapter');
          if (expression.questionDotToken && (object === null || object === undefined)) return undefined;
          if ((typeof key === 'string' || typeof key === 'number') && !RESERVED_KEYS.includes(String(key)) && object && typeof object === 'object') {
            if (Object.hasOwn(object, String(key))) return lookup(object as Record<string, unknown>, String(key));
            if (typeof key === 'string' && entryProps.has(object)) return entryProp(entryProps.get(object)!, key);
          }
        }
        if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
          const operand = value(expression.operand, mod, env, depth + 1);
          if (operand instanceof PropValue) throw new Error('Prop-dependent shared branches need a preview adapter');
          return !operand;
        }
        if (ts.isConditionalExpression(expression)) {
          const condition = value(expression.condition, mod, env, depth + 1);
          if (condition instanceof PropValue) throw new Error('Prop-dependent shared branches need a preview adapter');
          return value(condition ? expression.whenTrue : expression.whenFalse, mod, env, depth + 1);
        }
        if (ts.isBinaryExpression(expression)) {
          const operator = expression.operatorToken.kind;
          if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
            const left = value(expression.left, mod, env, depth + 1);
            if (left instanceof PropValue) throw new Error('Prop-dependent shared branches need a preview adapter');
            const settled = operator === ts.SyntaxKind.AmpersandAmpersandToken ? !left : operator === ts.SyntaxKind.BarBarToken ? !!left : left !== null && left !== undefined;
            return settled ? left : value(expression.right, mod, env, depth + 1);
          }
          if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            const left = value(expression.left, mod, env, depth + 1), right = value(expression.right, mod, env, depth + 1);
            if (left instanceof PropValue || right instanceof PropValue) throw new Error('Prop-dependent shared branches need a preview adapter');
            if ((left !== null && typeof left === 'object') || (right !== null && typeof right === 'object')) throw new Error(`Only scalar values can be compared statically: ${expression.getText(mod.source).slice(0, 100)}`);
            return (left === right) === (operator === ts.SyntaxKind.EqualsEqualsEqualsToken);
          }
        }
        // Decision 4: any other call is a gap for the whole call, and its arguments are never evaluated.
        if (ts.isCallExpression(expression) && isClsx(expression.expression, mod, env)) {
          return classList(expression.arguments.map((argument) => {
            if (ts.isSpreadElement(argument)) throw new Error(`Spread clsx arguments are unsupported: ${expression.getText(mod.source).slice(0, 100)}`);
            return value(argument, mod, env, depth + 1);
          }));
        }
        if (ts.isObjectLiteralExpression(expression)) {
          const result: Record<string, unknown> = {};
          for (const property of expression.properties) {
            let name: string, initializer: ts.Expression;
            if (ts.isShorthandPropertyAssignment(property)) { name = property.name.text; initializer = property.name; }
            else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) { name = property.name.text; initializer = property.initializer; }
            else if (ts.isPropertyAssignment(property) && ts.isComputedPropertyName(property.name)) {
              const computed = value(property.name.expression, mod, env, depth + 1);
              if (typeof computed !== 'string' && typeof computed !== 'number') throw new Error('Computed object keys must be static strings or numbers');
              name = String(computed); initializer = property.initializer;
            }
            else throw new Error('Unsupported object property');
            if (RESERVED_KEYS.includes(name)) throw new Error('Reserved object property');
            result[name] = value(initializer, mod, env, depth + 1);
          }
          return result;
        }
        if (ts.isArrayLiteralExpression(expression)) {
          if(expression.elements.some((item)=>ts.isOmittedExpression(item)||ts.isSpreadElement(item)))throw new Error('Sparse or spread source arrays need a preview adapter');
          const result=expression.elements.map((item)=>value(item,mod,env,depth+1));sampleArrays.add(result);return result;
        }
        return previewValue(expression, mod);
      }
      type ComponentFn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
      /** The function a component export names, or the local name a default export re-exports. */
      function componentFunction(mod: Module, name: string): { fn?: ComponentFn; redirect?: string } {
        let fn: ComponentFn | undefined;
        for (const statement of mod.source.statements) {
          if (ts.isFunctionDeclaration(statement) && (name === 'default' ? statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) : statement.name?.text === name)) fn = statement;
          if (ts.isExportAssignment(statement) && name === 'default') {
            const expression = statement.expression;
            if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) fn = expression;
            else if (ts.isIdentifier(expression)) {
              const local = mod.constants.get(expression.text);
              if (local && (ts.isArrowFunction(local) || ts.isFunctionExpression(local))) fn = local;
              else return { redirect: expression.text };
            }
          }
          if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) fn = declaration.initializer;
          }
        }
        return { fn };
      }
      /** Destructured props without a default that this occurrence omits (Ruling G). */
      function omittedProps(file: string, name: string, props: Record<string, Value>): string[] {
        const mod = module(file);
        let found = componentFunction(mod, name);
        for (let depth = 0; found.redirect !== undefined && depth < 10; depth++) found = componentFunction(mod, found.redirect);
        const parameter = found.fn?.parameters[0];
        if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return [];
        return parameter.name.elements.flatMap((binding) => {
          if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken || binding.initializer) return [];
          const key = binding.propertyName?.getText(mod.source) ?? binding.name.text;
          return key === 'children' || /^on[A-Z]/.test(key) || Object.hasOwn(props, key) ? [] : [key];
        });
      }
      /**
       * `isEntry` marks a page/layout entry component, whose props the importer does not supply come from choices.
       * `asDefinition` marks the root of a shared definition: only its own destructured props become declared props.
       * A component expanded inside a definition binds the values passed to it, which may forward the definition's props.
       */
      function renderComponent(file: string, name: string, props: Record<string, Value>, path: string, isEntry = false, asDefinition = false): DesignNode[] {
        const mod = module(file);
        const key = `${file}:${name}`;
        if (stack.includes(key) || stack.length > 40) throw new Error(`Recursive component ${key}`);
        stack.push(key);
        try {
          const { fn, redirect } = componentFunction(mod, name);
          if (redirect !== undefined) return renderComponent(file, redirect, props, path, isEntry, asDefinition);
          if (!fn?.body) throw new Error(`Cannot resolve component export ${name} in ${file}`);
          const env: Env = {};
          const parameter = fn.parameters[0];
          if (parameter) {
            if (ts.isIdentifier(parameter.name)) { env[parameter.name.text] = props; if (isEntry) entryProps.set(props, file); }
            else if (ts.isObjectBindingPattern(parameter.name)) for (const binding of parameter.name.elements) {
              if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken) throw new Error('Unsupported component props');
              const key = binding.propertyName?.getText(mod.source) ?? binding.name.text;
              if(/^on[A-Z]/.test(key))continue; // callback-only props do not affect a static preview unless read elsewhere
              if (asDefinition && declarations && key !== 'children') {
                if (!Object.hasOwn(props, key) && !binding.initializer) throw new OmittedProp(`Missing preview prop ${key} for ${name}`);
                if (binding.initializer) requiredProps?.delete(key);
                else requiredProps?.add(key);
                const defaultValue = binding.initializer ? value(binding.initializer, mod, env) : '';
                if (typeof defaultValue !== 'string') throw new Error('Shared component defaults must be strings');
                declarations[key] = { default: defaultValue };
                env[binding.name.text] = new PropValue(key);
              }
              else if (Object.hasOwn(props, key)) env[binding.name.text] = props[key]!;
              else if (binding.initializer) env[binding.name.text] = value(binding.initializer, mod, env);
              else if (isEntry) env[binding.name.text] = new Lazy(() => entryProp(file, key));
              else env[binding.name.text] = undefined; // Ruling G: an omitted prop without a default is undefined, as in JS.
            }
          }
          let body: ts.Expression | undefined;
          if (ts.isBlock(fn.body)) {
            for (const statement of fn.body.statements) {
              if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
                const initializer = declaration.initializer;
                // Decision 5: local bindings are evaluated lazily, on first use while rendering.
                const lazy = (compute: () => Value) => new Lazy(() => { currentFile = mod.source.fileName; return compute(); });
                if (ts.isIdentifier(declaration.name) && initializer) env[declaration.name.text] = lazy(() => value(initializer, mod, env));
                else if (ts.isObjectBindingPattern(declaration.name) && initializer) {
                  const source = lazy(() => value(initializer, mod, env));
                  for (const binding of declaration.name.elements) {
                    const property = binding.propertyName;
                    if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken || (property && !ts.isIdentifier(property) && !ts.isStringLiteral(property))) throw new Error(`Unsupported local binding ${declaration.name.getText(mod.source).slice(0, 100)}`);
                    const key = property ? property.text : binding.name.text, fallback = binding.initializer;
                    if (RESERVED_KEYS.includes(key)) throw new Error('Reserved object property');
                    env[binding.name.text] = lazy(() => {
                      const object = source.get();
                      if (object instanceof PropValue) throw new Error('Object preview props need a saved adapter');
                      if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`Cannot destructure ${key} from a non-object preview value: ${initializer.getText(mod.source).slice(0, 100)}`);
                      const found = Object.hasOwn(object, key) ? lookup(object, key) : entryProps.has(object) ? entryProp(entryProps.get(object)!, key) : undefined;
                      return found === undefined && fallback ? value(fallback, mod, env) : found;
                    });
                  }
                }
                else if (ts.isArrayBindingPattern(declaration.name)&&declaration.initializer&&ts.isCallExpression(declaration.initializer)&&reactHook(declaration.initializer.expression,mod,'useState')) {
                  const first=declaration.name.elements[0];
                  if(!first||!ts.isBindingElement(first)||!ts.isIdentifier(first.name)||first.dotDotDotToken||declaration.name.elements.length>2)throw new Error('Unsupported state binding');
                  env[first.name.text]=previewValue(declaration.initializer,mod);
                }
                else throw new Error(`Unsupported local binding ${declaration.name.getText(mod.source).slice(0, 100)}`);
              }
              else if (ts.isFunctionDeclaration(statement)) continue; // A local helper is never executed; calling it raises a gap.
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
      function renderExpression(expression: ts.Expression, mod: Module, env: Env, path: string): DesignNode[] {
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
        if (literal === null || literal === undefined || typeof literal === 'boolean') return [];
        if (typeof literal === 'object') throw new Error('Object is not a JSX child');
        return [{ id: nodeId(mod.source.fileName, path), kind: 'text', text: String(literal) }];
      }
      function children(items: ts.NodeArray<ts.JsxChild>, mod: Module, env: Env, path: string): DesignNode[] {
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
      /**
       * Whether an inlined component's definition would have prop-driven CSS, rendered as a definition once per route and
       * discarded, so that reason is found whether or not another route inlined the component first. Only nested
       * components that must be inlined escape; every other problem belongs to the inlined rendering, not to this probe.
       */
      function definitionHasPropCss(file: string, exportName: string, keys: string[]): boolean {
        const component = `C${stableId(`${file}:${exportName}`)}`;
        const before = new Set(Object.keys(definitions));
        const oldNamespace = idNamespace, oldDeclarations = declarations, oldRequired = requiredProps;
        idNamespace = component;
        declarations = Object.fromEntries(keys.map((key) => [key, { default: '' }]));
        requiredProps = new Set(keys);
        try { renderComponent(file, exportName, { ...Object.fromEntries(keys.map((key) => [key, new PropValue(key)])), children: [] }, 'definition', false, true); return false; }
        catch (error) { if (error instanceof Inline) throw error; return error instanceof PropDrivenCss; }
        finally {
          idNamespace = oldNamespace; declarations = oldDeclarations; requiredProps = oldRequired;
          for (const name of Object.keys(definitions)) if (!before.has(name)) { delete definitions[name]; requirements.delete(name); }
        }
      }
      function renderJsx(jsx: ts.JsxElement | ts.JsxSelfClosingElement, mod: Module, env: Env, path: string): DesignNode[] {
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
            const file = imported ? resolveFile(project, mod.source.fileName, imported.file) : mod.source.fileName;
            const exportName = imported?.name ?? tag;
            const key = `${file}:${exportName}`;
            encountered.add(key);
            // Ruling F/G: instances have no slots, caller CSS or absent props yet, so such a component is expanded in place.
            // The reasons are collected at every occurrence, inlined or not, so the reported reason never depends on order.
            const omitted = omittedProps(file, exportName, props);
            const caller: InlineReason | null = Object.hasOwn(props, 'className') || Object.hasOwn(props, 'style') ? 'prop-css' : omitted.length ? 'optional-prop' : nodes.length ? 'children' : null;
            if (caller) note(key, caller);
            if (caller && !inlineSet.has(key)) throw new Inline(key, caller);
            if (inlineSet.has(key)) {
              if (reasons.get(key) !== 'prop-css' && !tried.has(key)) {
                tried.add(key);
                if (definitionHasPropCss(file, exportName, [...Object.keys(props).filter((name) => name !== 'children'), ...omitted])) note(key, 'prop-css');
              }
              const expanded = renderComponent(file, exportName, props, `${path}/${tag}`);
              const root = expanded[0];
              if (expanded.length === 1 && root?.kind === 'element' && root.name === undefined) root.name = nameOf(key);
              return expanded;
            }
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
                let rendered: DesignNode[];
                try { rendered = renderComponent(file, exportName, { ...symbolic, children: [] }, 'definition', false, true); }
                catch (error) {
                  if (error instanceof PropDrivenCss) throw new Inline(key, 'prop-css');
                  if (error instanceof OmittedProp) throw new Inline(key, 'optional-prop');
                  throw error;
                }
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
            if (name === 'style' || name === 'className') throw new PropDrivenCss();
            attrs[name === 'htmlFor' ? 'for' : name] = `{{${literal.name}}}`;
            continue;
          }
          if (name === 'style') {
            if (!literal || typeof literal !== 'object' || Array.isArray(literal)) throw new Error('Inline style must be an object');
            const style: StyleMap = {};
            for (const [property, val] of Object.entries(literal)) {
              if (val instanceof PropValue) throw new PropDrivenCss();
              if (typeof val !== 'string') throw new Error('Inline styles require explicit CSS string values');
              style[property.startsWith('--') ? property : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] = val;
            }
            inline.set(id, style);
          } else if (literal !== false && literal !== null && literal !== undefined) {
            if (typeof literal === 'object') throw new Error(`Non-scalar attribute ${name}`);
            attrs[name === 'className' ? 'class' : name === 'htmlFor' ? 'for' : name] = literal === true ? '' : String(literal);
          }
        }
        return [{ id, kind: 'element', tag, attrs, style: { base: {} }, children: nodes }];
      }
      // Layout styles load before the page's styles, as in an App Router source hierarchy.
      for (const layout of entry.layouts ?? []) module(layout);
      let nodes = renderComponent(entry.file, entry.exportName ?? 'default', {}, 'page', true);
      for (const [index, layout] of [...(entry.layouts ?? [])].reverse().entries()) {
        nodes = renderComponent(layout, 'default', { children: nodes }, `layout/${index}`, true);
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
      // Ruling D: a page's tokens are the cascade over its stylesheets; routes must agree on every value.
      const resolved = winningTokens(tokens).map(({ group, name, value, file }): TokenSource => ({ group, name, value, file }))
        .sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const conflict = mergeTokens(doc.tokens, tokenOrigins, resolved);
      if (conflict) throw new CssError(conflict.file, conflict.message);
      doc.pages[id] = { id, name: entry.route, route: entry.route, root };
      dependencies[id] = [...files].sort();
      routeTokens[id] = resolved;
    } catch (error) {
      // Render the route again with the component inlined; nothing route-wide was written yet.
      if (error instanceof Inline && !inlineSet.has(error.key)) { inlineSet.set(error.key, error.reason); index--; continue; }
      diagnostics.push({ file: error instanceof PreviewRequired ? error.gap.file : error instanceof CssError ? error.file : currentFile, message: error instanceof Error ? error.message : 'Extraction failed', ...(error instanceof PreviewRequired ? { gap: error.gap } : {}) });
    }
    rendered.push({ entry, id: `page-${stableId(entry.route)}`, encountered, known, reasons });
  }
  // A route that rendered a component before it became inlined elsewhere must not keep it shared: start over.
  if (rendered.some(({ encountered, known }) => [...encountered].some((key) => inlineSet.has(key) && !known.has(key)))) return null;
  if (diagnostics.length) return { ok: false, diagnostics };
  const invalid = validateDoc(doc);
  if (invalid) return { ok: false, diagnostics: [{ file: '', message: invalid }] };
  // Reasons merge over routes by fixed priority; a component no route here gives a reason for keeps its input reason.
  const merged = new Map<string, InlineReason>();
  for (const { reasons } of rendered) for (const [key, reason] of reasons) merged.set(key, strongerReason(merged.get(key), reason));
  for (const [key, reason] of inlineSet) if (!merged.has(key)) merged.set(key, reason);
  const inlined: InlinedComponent[] = [];
  const inlining: Record<string, RouteInlining> = {};
  for (const { entry, id, encountered, reasons } of rendered) {
    const keys = [...encountered].sort();
    const routeInline = keys.filter((key) => inlineSet.has(key)).map((key) => ({ key, component: nameOf(key), file: key.slice(0, key.lastIndexOf(':')) }));
    for (const { key, component, file } of routeInline) inlined.push({ route: entry.route, component, file, reason: merged.get(key)! });
    // A route finds its own reasons whatever arrived inlined, so only components it has none for depend on the input.
    inlining[id] = { encountered: keys, input: routeInline.map(({ key }) => key).filter((key) => !reasons.has(key)), inline: routeInline, reasons: Object.fromEntries([...reasons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  }
  inlined.sort((a, b) => a.route !== b.route ? (a.route < b.route ? -1 : 1) : a.component !== b.component ? (a.component < b.component ? -1 : 1) : a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { ok: true, doc, dependencies, tokens: routeTokens, inlined, inlining };
}
