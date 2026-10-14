import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export const DEPLOY_DENY_RULES: readonly string[] = [
  'Bash(git push *)',
  'Bash(docker *)',
  'Bash(docker-compose *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(rsync *)',
  'Bash(kubectl *)',
  'Bash(hcloud *)',
  'Bash(gh pr merge *)',
  'Bash(gh workflow run *)',
  'Bash(gh release *)',
  'Bash(npm publish *)',
  'Bash(pnpm publish *)',
];

const GIT_PUSH_REASON = 'git push is done by the Hub after its checks pass.';
const MAIN_BRANCH_REASON = 'Stay on the task branch; the Hub manages main.';
const GH_REASON = 'Merges, releases and workflow runs go through the Hub.';
const PUBLISH_REASON = 'Publishing packages is not allowed in Build.';
const DEPLOY_SCRIPT_REASON = 'Deploying is a Hub action; deploy scripts are not allowed in Build.';
const HETZNER_REASON = 'Deploying is a Hub action; the Hetzner API is not allowed in Build.';
const ALIAS_REASON = 'Git and gh aliases can run deploys; they are not allowed in Build.';
const UNCLEAR_REASON = 'Build cannot tell which program this runs; name the program directly.';

/** Stands in for a $(...), <(...), >(...) or `...` substitution once its text has been checked. */
const SUBSTITUTION = '';

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const DEPLOY_PROGRAMS: ReadonlySet<string> = new Set([
  'docker',
  'docker-compose',
  'podman',
  'kubectl',
  'helm',
  'hcloud',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'flyctl',
  'fly',
  'vercel',
  'netlify',
  'terraform',
  'ansible',
  'ansible-playbook',
  'caddy',
]);

/** Programs that run another command in a way this guard does not model. Build does not run them. */
const FAIL_CLOSED_PROGRAMS: ReadonlySet<string> = new Set([
  'chroot',
  'coproc',
  'flock',
  'function',
  'nsenter',
  'parallel',
  'runuser',
  'script',
  'strace',
  'su',
  'unshare',
  'watch',
]);

/** Shell keywords that can precede a command. */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
]);

const SHELL_NAMES: ReadonlySet<string> = new Set([
  'ash',
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'sh',
  'tcsh',
  'zsh',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const GIT_PUSH_SUBCOMMANDS: ReadonlySet<string> = new Set(['push', 'send-pack', 'http-push']);
// Global git options that take their value as the next word.
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--attr-source',
]);

const GH_VALUE_FLAGS: ReadonlySet<string> = new Set(['-R', '--repo']);
const GH_FLAGS: ReadonlySet<string> = new Set(['-h', '--help', '--version']);

const NPM_FAMILY: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--cwd',
  '--dir',
  '--prefix',
  '-F',
  '--filter',
  '-w',
  '--workspace',
]);
const NPM_FLAGS: ReadonlySet<string> = new Set([
  '-h',
  '--help',
  '-v',
  '--version',
  '-r',
  '--recursive',
  '-s',
  '--silent',
  '-q',
  '--quiet',
  '--color',
  '--no-color',
  '--if-present',
  '--workspace-root',
  '--bail',
  '--no-bail',
]);
const NPM_RUN_ALIASES: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_EXEC_ALIASES: ReadonlySet<string> = new Set(['dlx', 'exec', 'x']);

const CURL_FAMILY: ReadonlySet<string> = new Set(['curl', 'http', 'https', 'wget']);

/**
 * How a wrapper's own arguments look, so the program word after them can be found.
 * An option that is not listed makes the command fail closed.
 */
interface ArgSpec {
  /** Short options that take no value. */
  flags: string;
  /** Short options whose value is the rest of the word or the next word. */
  values: string;
  /** Short options with a value only when attached (xargs -i{}). */
  optional?: string;
  longFlags?: readonly string[];
  /** Long options whose value is "--name=v" or the next word. */
  longValues?: readonly string[];
  /** Non-option words before the program (timeout DURATION). */
  positionals?: number;
  /** Also accepts +x options (shells). */
  plus?: boolean;
}

const SHELL_ARGS: ArgSpec = {
  flags: 'abcdeEfhiklmnprstuvxBCHPT',
  values: 'oO',
  plus: true,
  longFlags: ['login', 'norc', 'noprofile', 'posix', 'verbose', 'restricted', 'help', 'version'],
  longValues: ['rcfile', 'init-file'],
};

const RUNNER_ARGS: ArgSpec = {
  flags: 'yqn',
  values: 'p',
  longFlags: ['yes', 'no', 'quiet', 'no-install', 'ignore-existing', 'help', 'version'],
  longValues: ['package', 'registry'],
};

/** Wrapper commands run another program. Their options and positionals are skipped. */
const WRAPPER_ARGS: ReadonlyMap<string, ArgSpec> = new Map<string, ArgSpec>([
  [
    'sudo',
    {
      flags: 'AbeEHiKklnPSsVv',
      values: 'CDgprRtTUuh',
      longFlags: [
        'askpass',
        'background',
        'edit',
        'help',
        'login',
        'non-interactive',
        'preserve-env',
        'preserve-groups',
        'reset-timestamp',
        'remove-timestamp',
        'set-home',
        'shell',
        'stdin',
        'validate',
        'version',
        'list',
      ],
      longValues: [
        'user',
        'group',
        'host',
        'prompt',
        'role',
        'type',
        'command-timeout',
        'chdir',
        'chroot',
        'close-from',
        'other-user',
      ],
    },
  ],
  ['doas', { flags: 'nsL', values: 'aCu' }],
  [
    'timeout',
    {
      flags: 'v',
      values: 'ks',
      longFlags: ['foreground', 'preserve-status', 'verbose', 'help', 'version'],
      longValues: ['kill-after', 'signal'],
      positionals: 1,
    },
  ],
  ['nice', { flags: '', values: 'n', longFlags: ['help', 'version'], longValues: ['adjustment'] }],
  [
    'ionice',
    {
      flags: 't',
      values: 'cnpPu',
      longFlags: ['ignore', 'help', 'version'],
      longValues: ['class', 'classdata', 'pid', 'pgid', 'uid'],
    },
  ],
  ['nohup', { flags: '', values: '', longFlags: ['help', 'version'] }],
  [
    'stdbuf',
    { flags: '', values: 'ieo', longFlags: ['help', 'version'], longValues: ['input', 'output', 'error'] },
  ],
  [
    'time',
    {
      flags: 'apqv',
      values: 'fo',
      longFlags: ['append', 'portability', 'quiet', 'verbose', 'help', 'version'],
      longValues: ['format', 'output'],
    },
  ],
  ['command', { flags: 'pvV', values: '' }],
  ['exec', { flags: 'cl', values: 'a' }],
  ['builtin', { flags: '', values: '' }],
  [
    'env',
    {
      flags: 'i0v',
      values: 'uC',
      longFlags: ['ignore-environment', 'null', 'debug', 'help', 'version'],
      longValues: ['unset', 'chdir'],
    },
  ],
  [
    'xargs',
    {
      flags: '0prtxo',
      values: 'adEILnPs',
      optional: 'eil',
      longFlags: [
        'null',
        'no-run-if-empty',
        'interactive',
        'verbose',
        'exit',
        'show-limits',
        'help',
        'version',
        'eof',
        'replace',
        'max-lines',
      ],
      longValues: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'],
    },
  ],
  ['setsid', { flags: 'cfwe', values: '', longFlags: ['ctty', 'fork', 'wait', 'help', 'version'] }],
  ['chronic', { flags: 'ev', values: '' }],
  ['unbuffer', { flags: 'p', values: '' }],
  ['taskset', { flags: 'cpahV', values: '', positionals: 1 }],
  ['busybox', { flags: '', values: '' }],
  ['npx', RUNNER_ARGS],
  ['pnpx', RUNNER_ARGS],
  ['bunx', RUNNER_ARGS],
  ...[...SHELL_NAMES].map((name): [string, ArgSpec] => [name, SHELL_ARGS]),
]);

/** One shell word. `dynamic` means its value is not known until the shell runs it. */
interface Word {
  /** The word with quotes and escapes removed. */
  text: string;
  /** The word as written, quotes included. */
  raw: string;
  dynamic: boolean;
}

type Found = { kind: 'program'; index: number } | { kind: 'reason'; reason: string } | { kind: 'inert' };

function isDynamic(raw: string): boolean {
  if (/[$*?]/.test(raw)) return true;
  return /[[{]/.test(raw) && raw !== '[' && raw !== '[[' && raw !== '{';
}

/**
 * Splits one simple command into words the way the shell does for what matters here:
 * unquoted whitespace separates words, quote characters and backslash escapes are removed,
 * and redirections are dropped together with their targets.
 */
function tokenize(segment: string): Word[] {
  const words: Word[] = [];
  let text = '';
  let raw = '';
  let inWord = false;
  let pendingTarget = false;
  let quote: '"' | "'" | null = null;

  const finishWord = (): void => {
    if (!inWord) return;
    if (pendingTarget) {
      pendingTarget = false;
    } else {
      words.push({ text, raw, dynamic: isDynamic(raw) });
    }
    text = '';
    raw = '';
    inWord = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    const next = segment.charAt(i + 1);
    if (quote === "'") {
      raw += ch;
      if (ch === "'") quote = null;
      else text += ch;
    } else if (quote === '"') {
      raw += ch;
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && next !== '' && '"\\$`'.includes(next)) {
        raw += next;
        text += next;
        i++;
      } else {
        text += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      raw += ch;
      inWord = true;
    } else if (ch === '\\' && next !== '') {
      raw += ch + next;
      text += next;
      inWord = true;
      i++;
    } else if (ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      // A bare fd number before the operator (the 2 in 2>&1) is not a word.
      if (inWord && /^\d+$/.test(raw)) {
        text = '';
        raw = '';
        inWord = false;
      } else {
        finishWord();
      }
      while (i + 1 < segment.length && '<>&|'.includes(segment.charAt(i + 1))) i++;
      pendingTarget = true;
    } else if (/\s/.test(ch)) {
      finishWord();
    } else {
      text += ch;
      raw += ch;
      inWord = true;
    }
  }
  finishWord();
  return words;
}

/**
 * Index of the first word after a wrapper's options, plus the short option letters seen.
 * Returns null when an option is not in the spec.
 */
function skipArgs(
  words: readonly Word[],
  start: number,
  spec: ArgSpec,
): { next: number; letters: string } | null {
  let i = start;
  let letters = '';
  while (i < words.length) {
    const text = words[i]?.text ?? '';
    if (text === '--') return { next: i + 1, letters };
    if (text === '-') {
      i++;
      continue;
    }
    const isOption = text.startsWith('-') || (spec.plus === true && text.startsWith('+'));
    if (!isOption) break;
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq === -1 ? text.slice(2) : text.slice(2, eq);
      if (spec.longValues?.includes(name)) {
        i += eq === -1 ? 2 : 1;
        continue;
      }
      if (spec.longFlags?.includes(name)) {
        i++;
        continue;
      }
      return null;
    }
    // A short-option cluster such as -oL, -s9 or -u root.
    let next = i + 1;
    const cluster = text.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const letter = cluster.charAt(k);
      letters += letter;
      const attached = k < cluster.length - 1;
      if (spec.values.includes(letter)) {
        next = attached ? i + 1 : i + 2;
        break;
      }
      if (spec.optional?.includes(letter) && attached) break;
      if (spec.flags.includes(letter) || spec.optional?.includes(letter)) continue;
      return null;
    }
    i = next;
  }
  return { next: i, letters };
}

/** Index of the program word, after assignments, keywords, options and wrapper arguments. */
function findProgram(words: readonly Word[]): Found {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === undefined) break;
    const { text, dynamic } = word;
    if (ASSIGNMENT.test(text) || SHELL_KEYWORDS.has(text)) {
      i++;
      continue;
    }
    if (dynamic) break;
    if (text.startsWith('-')) {
      i++;
      continue;
    }
    const name = basename(text);
    const spec = WRAPPER_ARGS.get(name);
    if (spec === undefined) break;
    const skipped = skipArgs(words, i + 1, spec);
    if (skipped === null) return { kind: 'reason', reason: UNCLEAR_REASON };
    if (name === 'command' && /[vV]/.test(skipped.letters)) return { kind: 'inert' };
    if (SHELL_NAMES.has(name)) {
      const operandMissing = skipped.next >= words.length;
      if (skipped.letters.includes('c')) {
        // The command string after -c is the program; a quoted one is checked as a command line.
        if (operandMissing) return { kind: 'reason', reason: UNCLEAR_REASON };
        return { kind: 'program', index: skipped.next };
      }
      // A bare shell reads commands from stdin, which this guard cannot see.
      if (operandMissing || skipped.letters.includes('s')) return { kind: 'reason', reason: UNCLEAR_REASON };
      return { kind: 'program', index: skipped.next };
    }
    i = skipped.next + (spec.positionals ?? 0);
  }
  return { kind: 'program', index: i };
}

/** The words from the first non-option word on (skipping option values). Empty if none. */
function operandsAfterOptions(args: readonly Word[], valueFlags: ReadonlySet<string>): Word[] {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    if (valueFlags.has(word.text)) {
      i++;
      continue;
    }
    if (!word.text.startsWith('-')) return args.slice(i);
  }
  return [];
}

function gitReason(args: readonly Word[]): string | null {
  if (args.some((w) => w.text.includes('alias.'))) return ALIAS_REASON;
  const operands = operandsAfterOptions(args, GIT_VALUE_FLAGS);
  const sub = operands[0];
  if (sub === undefined || sub.dynamic) return UNCLEAR_REASON;
  if (GIT_PUSH_SUBCOMMANDS.has(sub.text)) return GIT_PUSH_REASON;
  if (sub.text === 'checkout' || sub.text === 'switch') {
    const later = operands.slice(1);
    if (later.some((w) => w.dynamic)) return UNCLEAR_REASON;
    if (later.some((w) => w.text === 'main' || w.text === 'master')) return MAIN_BRANCH_REASON;
  }
  return null;
}

function ghReason(args: readonly Word[]): string | null {
  const operands: Word[] = [];
  for (let i = 0; i < args.length && operands.length < 2; i++) {
    const word = args[i];
    if (word === undefined) break;
    const text = word.text;
    if (GH_VALUE_FLAGS.has(text)) {
      i++;
      continue;
    }
    const attachedRepo = text.startsWith('--repo=') || (text.startsWith('-R') && text.length > 2);
    if (attachedRepo || GH_FLAGS.has(text)) continue;
    if (text.startsWith('-')) return UNCLEAR_REASON;
    operands.push(word);
  }
  const [first, second] = operands;
  if (first === undefined || first.dynamic || second?.dynamic === true) return UNCLEAR_REASON;
  const sub = first.text;
  const action = second?.text ?? '';
  if (sub === 'alias') return ALIAS_REASON;
  if ((sub === 'pr' && action === 'merge') || (sub === 'workflow' && action === 'run')) return GH_REASON;
  if (['release', 'secret', 'api'].includes(sub)) return GH_REASON;
  return null;
}

/** The script named after `run` (options before it are skipped). */
function npmRunReason(args: readonly Word[], start: number): string | null {
  let endOfOptions = false;
  for (let i = start; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    if (!endOfOptions && word.text === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && NPM_VALUE_FLAGS.has(word.text)) {
      i++;
      continue;
    }
    if (!endOfOptions && word.text.startsWith('-')) continue;
    if (word.dynamic) return UNCLEAR_REASON;
    return word.text.startsWith('deploy') ? DEPLOY_SCRIPT_REASON : null;
  }
  return UNCLEAR_REASON;
}

function npmReason(args: readonly Word[]): string | null {
  if (args.some((w) => w.text === 'publish')) return PUBLISH_REASON;
  let i = 0;
  while (i < args.length) {
    const text = args[i]?.text ?? '';
    if (NPM_VALUE_FLAGS.has(text)) {
      i += 2;
      continue;
    }
    if (NPM_FLAGS.has(text) || (text.startsWith('--') && text.includes('='))) {
      i++;
      continue;
    }
    if (text.startsWith('-')) return UNCLEAR_REASON;
    break;
  }
  const sub = args[i];
  if (sub === undefined || sub.dynamic) return UNCLEAR_REASON;
  // Bare scripts (pnpm deploy:prod) run the same way as "run".
  if (sub.text.startsWith('deploy')) return DEPLOY_SCRIPT_REASON;
  if (NPM_RUN_ALIASES.has(sub.text)) return npmRunReason(args, i + 1);
  if (NPM_EXEC_ALIASES.has(sub.text)) {
    let rest = args.slice(i + 1);
    if (rest[0]?.text === '--') rest = rest.slice(1);
    if (rest.length === 0 || (rest[0]?.text ?? '').startsWith('-')) return UNCLEAR_REASON;
    return segmentReason(rest);
  }
  return null;
}

function curlReason(args: readonly Word[]): string | null {
  if (args.some((w) => w.text.toLowerCase().includes('api.hetzner.cloud'))) return HETZNER_REASON;
  // A substitution, or URL globbing next to a host name, could hide the host.
  if (args.some((w) => /[$]/.test(w.raw) || (/[[{]/.test(w.raw) && w.text.includes('.')))) {
    return UNCLEAR_REASON;
  }
  return null;
}

function segmentReason(words: readonly Word[]): string | null {
  const found = findProgram(words);
  if (found.kind === 'reason') return found.reason;
  if (found.kind === 'inert') return null;
  const program = words[found.index];
  if (program === undefined) return null;
  if (program.dynamic) return UNCLEAR_REASON;
  // A quoted command string, e.g. bash -c "ssh host": check it as a command line.
  if (/\s/.test(program.text)) return deployDenyReason(program.text);

  const name = basename(program.text);
  const args = words.slice(found.index + 1);
  if (FAIL_CLOSED_PROGRAMS.has(name)) return UNCLEAR_REASON;
  if (name === 'eval') return deployDenyReason(args.map((w) => w.text).join(' '));
  if (name === 'find' && args.some((w) => FIND_EXEC.has(w.text))) return UNCLEAR_REASON;
  if (name === 'git') return gitReason(args);
  if (DEPLOY_PROGRAMS.has(name)) return `Deploying is a Hub action; ${name} is not allowed in Build.`;
  if (name === 'gh') return ghReason(args);
  if (NPM_FAMILY.has(name)) return npmReason(args);
  if (CURL_FAMILY.has(name)) return curlReason(args);
  return null;
}

/** Splits on separators. "&" and "|" that belong to a redirection (&>, >&, >|) do not split. */
const SEPARATORS = /&&|\|\||(?<![<>])[|&](?!>)|[;\n]/;

function matchingParen(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    const ch = input.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Checks each $(...), <(...), >(...) and `...` on its own, and replaces it with a marker.
 * A marker inside a word makes that word dynamic, so a program or rule word built from a
 * substitution fails closed.
 */
function replaceSubstitutions(input: string): { text: string } | { reason: string } {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    const next = input.charAt(i + 1);
    if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
      const close = matchingParen(input, i + 1);
      if (close === -1) return { reason: UNCLEAR_REASON };
      const reason = deployDenyReason(input.slice(i + 2, close));
      if (reason !== null) return { reason };
      out += SUBSTITUTION;
      i = close + 1;
      continue;
    }
    if (ch === '`') {
      const close = input.indexOf('`', i + 1);
      if (close === -1) return { reason: UNCLEAR_REASON };
      const reason = deployDenyReason(input.slice(i + 1, close));
      if (reason !== null) return { reason };
      out += SUBSTITUTION;
      i = close + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out };
}

/** Returns why a Bash command must not run in Build, or null. Deliberately conservative. */
export function deployDenyReason(command: string): string | null {
  if (/GIT_CONFIG/.test(command) && /alias\./.test(command)) return ALIAS_REASON;
  // A backslash-newline is a line continuation only when the backslash is not itself escaped.
  const joined = command.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, '$1');
  const substituted = replaceSubstitutions(joined);
  if ('reason' in substituted) return substituted.reason;
  // "f() {" and "a=()" are definitions this guard does not model.
  if (/\(\s*\)/.test(substituted.text)) return UNCLEAR_REASON;
  const flat = substituted.text.replace(/[()]/g, ';');
  for (const segment of flat.split(SEPARATORS)) {
    const words = tokenize(segment);
    if (words.length === 0) continue;
    const reason = segmentReason(words);
    if (reason !== null) return reason;
  }
  return null;
}

export function checkToolUse(cwd: string, toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') return deployDenyReason(String(input.command ?? ''));
  if (!EDIT_TOOLS.has(toolName)) return null;
  const target = resolve(cwd, String(input.file_path ?? input.notebook_path ?? ''));
  const rel = relative(cwd, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `Edits must stay inside the app checkout (${cwd}).`;
  }
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) return 'Do not edit .git directly.';
  return null;
}
