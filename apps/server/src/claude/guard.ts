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
const UNCLEAR_REASON = 'Build cannot tell which program this runs; name the program directly.';

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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * How a wrapper's own arguments look, so the program word after them can be found.
 * Anything not listed is unknown, and an unknown option makes the command fail closed.
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
  ['bash', SHELL_ARGS],
  ['sh', SHELL_ARGS],
  ['zsh', SHELL_ARGS],
]);

/**
 * Splits one simple command into words the way the shell does for what matters here:
 * unquoted whitespace separates words, quote characters are removed, and a backslash
 * escapes the next character.
 */
function tokenize(segment: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
    } else if (quote === '"') {
      const next = segment.charAt(i + 1);
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < segment.length && '"\\$`'.includes(next)) {
        word += next;
        i++;
      } else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < segment.length) {
      word += segment.charAt(i + 1);
      i++;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(word);
        word = '';
        inWord = false;
      }
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * Index of the first word after a wrapper's options, or null when an option is not known.
 * Stops at the first non-option word, or after "--".
 */
function skipArgs(words: readonly string[], start: number, spec: ArgSpec): number | null {
  let i = start;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (word === '--') return i + 1;
    if (word === '-') {
      i++;
      continue;
    }
    const isOption = word.startsWith('-') || (spec.plus === true && word.startsWith('+'));
    if (!isOption) break;
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word.slice(2) : word.slice(2, eq);
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
    const letters = word.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const letter = letters.charAt(k);
      const attached = k < letters.length - 1;
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
  return i;
}

/** Index of the program word, after assignments, keywords, options and wrapper arguments. */
function findProgram(words: readonly string[]): { index: number } | { reason: string } {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (ASSIGNMENT.test(word) || SHELL_KEYWORDS.has(word) || word.startsWith('-')) {
      i++;
      continue;
    }
    const spec = WRAPPER_ARGS.get(basename(word));
    if (spec === undefined) break;
    const next = skipArgs(words, i + 1, spec);
    if (next === null) return { reason: UNCLEAR_REASON };
    i = next + (spec.positionals ?? 0);
  }
  return { index: i };
}

/** The words from the first non-option word on (skipping option values). Empty if none. */
function afterOptions(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? '';
    if (valueFlags.has(word)) {
      i++;
      continue;
    }
    if (!word.startsWith('-')) return args.slice(i);
  }
  return [];
}

// Global options that take their value as the next word, per program.
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GH_VALUE_FLAGS: ReadonlySet<string> = new Set(['-R', '--repo']);
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

function segmentReason(words: readonly string[]): string | null {
  const found = findProgram(words);
  if ('reason' in found) return found.reason;
  const program = words[found.index];
  if (program === undefined) return null;
  // A quoted string used as a command, e.g. bash -c "ssh host": check it as a command line.
  if (/\s/.test(program)) return deployDenyReason(program);
  // A program name built at run time (variables, globs, braces) cannot be checked.
  if (/[$*?]|\[.*\]/.test(program) || (/[{}]/.test(program) && program.length > 1)) return UNCLEAR_REASON;

  const name = basename(program);
  const args = words.slice(found.index + 1);
  if (name === 'eval') return deployDenyReason(args.join(' '));

  if (name === 'git') {
    const [sub, ...later] = afterOptions(args, GIT_VALUE_FLAGS);
    if (sub === 'push') return GIT_PUSH_REASON;
    if ((sub === 'checkout' || sub === 'switch') && later.some((w) => w === 'main' || w === 'master')) {
      return MAIN_BRANCH_REASON;
    }
  }
  if (DEPLOY_PROGRAMS.has(name)) {
    return `Deploying is a Hub action; ${name} is not allowed in Build.`;
  }
  if (name === 'gh') {
    const [a = '', b = ''] = afterOptions(args, GH_VALUE_FLAGS);
    const isMerge = a === 'pr' && b === 'merge';
    const isWorkflowRun = a === 'workflow' && b === 'run';
    if (isMerge || isWorkflowRun || ['release', 'secret', 'api'].includes(a)) return GH_REASON;
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    if (args.includes('publish')) return PUBLISH_REASON;
    const [a = '', b = ''] = afterOptions(args, NPM_VALUE_FLAGS);
    if (a === 'deploy' || (a === 'run' && b.startsWith('deploy'))) return DEPLOY_SCRIPT_REASON;
  }
  if ((name === 'curl' || name === 'wget') && args.some((w) => w.includes('api.hetzner.cloud'))) {
    return HETZNER_REASON;
  }
  return null;
}

/** Returns why a Bash command must not run in Build, or null. Deliberately conservative. */
export function deployDenyReason(command: string): string | null {
  const s = command
    .replace(/\\\r?\n/g, '')
    .replace(/\$\(/g, ';')
    .replace(/[()`]/g, ';')
    .replace(/[<>]/g, ' ');
  for (const segment of s.split(/&&|\|\||[;|&\n]/)) {
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
