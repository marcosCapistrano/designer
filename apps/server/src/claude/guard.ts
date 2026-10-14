import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type LexWord, MAX_NESTING, lexShell } from './shell-lexer.js';

/**
 * The deploy guard: refuses Bash commands that push, merge, deploy or reach Hetzner.
 *
 * It is defense in depth, not the control (Claude never holds deploy credentials), so it fails closed:
 * a command it cannot read, or a program it cannot name, is denied with UNCLEAR_REASON.
 *
 * shell-lexer.ts reads the command once, quote-aware, and returns simple commands whose words know
 * whether they are dynamic. The rules below work on that output only: find the program (after
 * assignments, keywords and wrappers), then apply the rules for that program. Nothing here looks for
 * separators, parentheses or globs in raw command text.
 */
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

/**
 * Programs and builtins that run other code in a way this guard does not model (a later time,
 * another terminal, a root shell, a job queue, a handler). Build does not run them.
 */
const FAIL_CLOSED_PROGRAMS: ReadonlySet<string> = new Set([
  'alias',
  'at',
  'batch',
  'bwrap',
  'chroot',
  'coproc',
  'crontab',
  'dtach',
  'expect',
  'firejail',
  'flock',
  'function',
  'newgrp',
  'nsenter',
  'parallel',
  'runuser',
  'screen',
  'script',
  'setpriv',
  'sg',
  'strace',
  'su',
  'tmux',
  'trap',
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
  'mksh',
  'oksh',
  'pdksh',
  'posh',
  'rbash',
  'sh',
  'tcsh',
  'yash',
  'zsh',
]);

/** NAME=value and NAME+=value. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** `source /dev/stdin` and friends read commands from somewhere this guard cannot see. */
const STDIN_SCRIPT = /^\/(?:dev\/(?:stdin|fd\/)|proc\/self\/fd\/)/;

const GIT_PUSH_SUBCOMMANDS: ReadonlySet<string> = new Set(['push', 'send-pack', 'http-push']);
/** git subcommands that push when their own subcommand is `push`. */
const GIT_PUSH_VIA: ReadonlySet<string> = new Set(['subtree', 'lfs', 'for-each-repo']);
/** `git rebase -x CMD`, `--exec CMD`, `--exec=CMD` and clusters such as `-ix`. */
const GIT_REBASE_EXEC = /^(?:--exec(?:=|$)|-[A-Za-z]*x)/;
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
/** `-w` is left out: npm takes a value after it and pnpm does not, so both readings are tried. */
const NPM_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '--cwd', '--dir', '--prefix', '-F', '--filter', '--workspace']);
const NPM_VALUE_FLAGS_W: ReadonlySet<string> = new Set([...NPM_VALUE_FLAGS, '-w']);
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
  '--workspaces',
  '-ws',
  '--include-workspace-root',
  '-iwr',
  '--ignore-scripts',
  '--foreground-scripts',
  '--parallel',
  '--stream',
  '--sequential',
  '--no-sort',
  '--bail',
  '--no-bail',
]);
const NPM_RUN_ALIASES: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_EXEC_ALIASES: ReadonlySet<string> = new Set(['dlx', 'exec', 'x']);
/** pnpm's `recursive`, `multi` and `m` take another pnpm command. */
const NPM_RECURSIVE: ReadonlySet<string> = new Set(['recursive', 'multi', 'm']);
const FOREACH_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '--all',
  '-R',
  '--recursive',
  '-W',
  '--worktree',
  '-p',
  '--parallel',
  '-i',
  '--interlaced',
  '-v',
  '--verbose',
  '-t',
  '--topological',
  '--topological-dev',
  '--no-private',
]);
const FOREACH_VALUE_FLAGS: ReadonlySet<string> = new Set(['-j', '--jobs', '--include', '--exclude', '--from']);

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
  /** xargs: -I, -i and --replace name a string that is filled in at run time. */
  replace?: boolean;
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
    'pkexec',
    { flags: '', values: '', longFlags: ['version', 'help', 'disable-internal-agent', 'keep-cwd'], longValues: ['user'] },
  ],
  [
    'run0',
    {
      flags: 'h',
      values: 'uDgEM',
      longFlags: ['help', 'version', 'no-ask-password', 'no-pager', 'empower', 'via-shell'],
      longValues: [
        'unit',
        'property',
        'description',
        'slice',
        'user',
        'group',
        'nice',
        'chdir',
        'setenv',
        'machine',
        'area',
        'background',
        'lightweight',
      ],
    },
  ],
  [
    'systemd-run',
    {
      flags: 'tPqGdSh',
      values: 'uHMpE',
      longFlags: [
        'pty',
        'pipe',
        'quiet',
        'collect',
        'same-dir',
        'shell',
        'help',
        'version',
        'scope',
        'user',
        'system',
        'remain-after-exit',
        'send-sighup',
        'wait',
        'no-block',
        'no-ask-password',
        'no-pager',
        'ignore-failure',
      ],
      longValues: [
        'unit',
        'description',
        'slice',
        'property',
        'uid',
        'gid',
        'nice',
        'setenv',
        'working-directory',
        'service-type',
        'on-active',
        'on-boot',
        'on-startup',
        'on-unit-active',
        'on-unit-inactive',
        'on-calendar',
        'timer-property',
        'host',
        'machine',
      ],
    },
  ],
  ['ssh-agent', { flags: 'cDdksuU', values: 'aEOPt' }],
  ['sshpass', { flags: 'evhV', values: 'fdpP' }],
  [
    'fakeroot',
    {
      flags: 'uhv',
      values: 'lfisb',
      longFlags: ['unknown-is-real', 'help', 'version'],
      longValues: ['lib', 'faked', 'fd-base'],
    },
  ],
  [
    'numactl',
    {
      flags: 'alHst',
      values: 'ipCNmS',
      longFlags: ['all', 'localalloc', 'hardware', 'show', 'touch', 'help', 'version'],
      longValues: ['interleave', 'preferred', 'physcpubind', 'cpunodebind', 'cpubind', 'membind', 'shm'],
    },
  ],
  ['corepack', { flags: '', values: '', longFlags: ['help', 'version'] }],
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
      replace: true,
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

/** What the rules know about the command being checked. */
interface Ctx {
  /** How many `-c` strings and `eval`s deep this text is. */
  depth: number;
  /** A heredoc is attached to this command's standard input. */
  heredoc: boolean;
  /** Words may be appended to this command at run time (it runs under xargs). */
  open: boolean;
}

type Found =
  | { kind: 'program'; index: number; words: readonly LexWord[]; open: boolean; lastWrapperUnfinished: boolean }
  /** The operand of `sh -c`: a command line the inner shell reads again, quotes and all. */
  | { kind: 'script'; word: LexWord }
  | { kind: 'reason'; reason: string }
  | { kind: 'inert' };

interface Skipped {
  next: number;
  letters: string;
  longs: string[];
  /** xargs: the string that -I, -i or --replace fills in. */
  replace: string | undefined;
}

/** The program a word names: no directory, and no `@version` (npx vercel@latest, corepack pnpm@9). */
function programName(text: string): string {
  return basename(text).replace(/(?<=.)@[^@]*$/, '');
}

/**
 * Index of the first word after a wrapper's options, plus the short option letters seen.
 * Returns null when an option is not in the spec.
 */
function skipArgs(words: readonly LexWord[], start: number, spec: ArgSpec): Skipped | null {
  let i = start;
  let letters = '';
  const longs: string[] = [];
  let replace: string | undefined;
  while (i < words.length) {
    const text = words[i]?.text ?? '';
    if (text === '--') return { next: i + 1, letters, longs, replace };
    if (text === '-') {
      i++;
      continue;
    }
    const isOption = text.startsWith('-') || (spec.plus === true && text.startsWith('+'));
    if (!isOption) break;
    if (text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq === -1 ? text.slice(2) : text.slice(2, eq);
      longs.push(name);
      if (spec.replace === true && name === 'replace') replace = eq === -1 ? '{}' : text.slice(eq + 1);
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
        if (spec.replace === true && letter === 'I') {
          replace = attached ? cluster.slice(k + 1) : (words[i + 1]?.text ?? '');
        }
        next = attached ? i + 1 : i + 2;
        break;
      }
      if (spec.optional?.includes(letter) === true) {
        if (spec.replace === true && letter === 'i') replace = attached ? cluster.slice(k + 1) : '{}';
        if (attached) break;
        continue;
      }
      if (spec.flags.includes(letter)) continue;
      return null;
    }
    i = next;
  }
  return { next: i, letters, longs, replace };
}

/** Index of the program word, after assignments, keywords, options and wrapper arguments. */
function findProgram(input: readonly LexWord[], ctx: Ctx): Found {
  let words = input;
  let open = ctx.open;
  // A wrapper that comes under xargs and names no program: xargs supplies the program word.
  let wrapperUnderXargs = false;
  let wrappers = 0;
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
    const name = programName(text);
    const spec = WRAPPER_ARGS.get(name);
    if (spec === undefined) break;
    // Nobody stacks this many wrappers, and each xargs copies the words that follow it.
    if (++wrappers > MAX_NESTING) return { kind: 'reason', reason: UNCLEAR_REASON };
    const skipped = skipArgs(words, i + 1, spec);
    if (skipped === null) return { kind: 'reason', reason: UNCLEAR_REASON };
    if (name === 'command' && /[vV]/.test(skipped.letters)) return { kind: 'inert' };
    if (SHELL_NAMES.has(name)) {
      // A heredoc or a bare shell feeds commands through stdin, which this guard cannot see.
      if (ctx.heredoc) return { kind: 'reason', reason: UNCLEAR_REASON };
      const operandMissing = skipped.next >= words.length;
      if (skipped.letters.includes('c')) {
        // The command string after -c is the program; a quoted one is checked as a command line.
        const script = words[skipped.next];
        if (operandMissing || script === undefined) return { kind: 'reason', reason: UNCLEAR_REASON };
        return { kind: 'script', word: script };
      }
      if (operandMissing || skipped.letters.includes('s')) return { kind: 'reason', reason: UNCLEAR_REASON };
      return { kind: 'program', index: skipped.next, words, open, lastWrapperUnfinished: false };
    }
    if (open && name !== 'xargs') wrapperUnderXargs = true;
    if (name === 'xargs') {
      if (ctx.heredoc) return { kind: 'reason', reason: UNCLEAR_REASON };
      open = true;
      const replace = skipped.replace;
      if (replace !== undefined && replace !== '') {
        // Every word that holds the replace string is filled in at run time.
        words = words.map((w, index) =>
          index >= skipped.next && w.text.includes(replace) ? { ...w, dynamic: true, expanded: true } : w,
        );
      }
    }
    if (
      (name === 'sudo' || name === 'doas') &&
      skipped.next >= words.length &&
      (/[si]/.test(skipped.letters) || skipped.longs.includes('shell') || skipped.longs.includes('login'))
    ) {
      // sudo -s and sudo -i with no command start a shell that reads stdin.
      return { kind: 'reason', reason: UNCLEAR_REASON };
    }
    i = skipped.next + (spec.positionals ?? 0);
  }
  return { kind: 'program', index: i, words, open, lastWrapperUnfinished: wrapperUnderXargs };
}

/** The words from the first non-option word on (skipping option values). Empty if none. */
function operandsAfterOptions(args: readonly LexWord[], valueFlags: ReadonlySet<string>): LexWord[] {
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

/** The same command one level further down: a runner that runs a runner that runs a runner... */
function deeper(ctx: Ctx): Ctx {
  return { ...ctx, depth: ctx.depth + 1 };
}

function gitReason(args: readonly LexWord[], ctx: Ctx): string | null {
  if (args.some((w) => w.text.toLowerCase().includes('alias.'))) return ALIAS_REASON;
  const operands = operandsAfterOptions(args, GIT_VALUE_FLAGS);
  const sub = operands[0];
  if (sub === undefined || sub.dynamic) return UNCLEAR_REASON;
  const later = operands.slice(1);
  if (GIT_PUSH_SUBCOMMANDS.has(sub.text)) return GIT_PUSH_REASON;
  if (sub.text === 'checkout' || sub.text === 'switch') {
    // Under xargs the branch name may still arrive.
    if (ctx.open || later.some((w) => w.dynamic)) return UNCLEAR_REASON;
    if (later.some((w) => w.text === 'main' || w.text === 'master')) return MAIN_BRANCH_REASON;
    return null;
  }
  // Subcommands that push, or that run a command the Hub has not checked.
  if (sub.text === 'submodule' && later.some((w) => w.text === 'foreach')) return GIT_PUSH_REASON;
  if (sub.text === 'rebase' && later.some((w) => GIT_REBASE_EXEC.test(w.text))) return GIT_PUSH_REASON;
  if (GIT_PUSH_VIA.has(sub.text) && later.some((w) => w.text === 'push')) return GIT_PUSH_REASON;
  if (sub.text === 'bisect') {
    const run = later.findIndex((w) => w.text === 'run');
    if (run !== -1) {
      const command = later.slice(run + 1);
      return command.length === 0 ? UNCLEAR_REASON : commandReason(command, deeper(ctx));
    }
  }
  return null;
}

function ghReason(args: readonly LexWord[], ctx: Ctx): string | null {
  const operands: LexWord[] = [];
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
  // Under xargs the action may still arrive.
  if (ctx.open && second === undefined) return UNCLEAR_REASON;
  return null;
}

/** A package script named by a pattern (pnpm's /regex/ and * selectors) can match a deploy script. */
function isScriptSelector(text: string): boolean {
  return text.startsWith('/') || /[*?[]/.test(text);
}

/** The script named after `run` (options before it are skipped). */
function npmRunReason(args: readonly LexWord[], start: number, wTakesValue: boolean): string | null {
  const valueFlags = wTakesValue ? NPM_VALUE_FLAGS_W : NPM_VALUE_FLAGS;
  let endOfOptions = false;
  for (let i = start; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    const text = word.text;
    if (!endOfOptions) {
      if (text === '--') {
        endOfOptions = true;
        continue;
      }
      if (valueFlags.has(text)) {
        i++;
        continue;
      }
      if (NPM_FLAGS.has(text) || (!wTakesValue && text === '-w') || (text.startsWith('--') && text.includes('='))) {
        continue;
      }
      // An option this guard does not know could take the next word as its value.
      if (text.startsWith('-')) return UNCLEAR_REASON;
    }
    if (word.dynamic || isScriptSelector(text)) return UNCLEAR_REASON;
    return text.startsWith('deploy') ? DEPLOY_SCRIPT_REASON : null;
  }
  return UNCLEAR_REASON;
}

/** After `yarn workspaces foreach`: the words from the yarn command on, or null if a flag is unknown. */
function skipForeachFlags(words: readonly LexWord[]): readonly LexWord[] | null {
  let i = 0;
  while (i < words.length) {
    const text = words[i]?.text ?? '';
    if (FOREACH_VALUE_FLAGS.has(text)) {
      i += 2;
    } else if (FOREACH_FLAGS.has(text) || (text.startsWith('--') && text.includes('='))) {
      i++;
    } else if (text.startsWith('-')) {
      return null;
    } else {
      break;
    }
  }
  return words.slice(i);
}

function npmParse(args: readonly LexWord[], ctx: Ctx, wTakesValue: boolean): string | null {
  const valueFlags = wTakesValue ? NPM_VALUE_FLAGS_W : NPM_VALUE_FLAGS;
  let i = 0;
  while (i < args.length) {
    const text = args[i]?.text ?? '';
    if (valueFlags.has(text)) {
      i += 2;
      continue;
    }
    if (NPM_FLAGS.has(text) || (!wTakesValue && text === '-w') || (text.startsWith('--') && text.includes('='))) {
      i++;
      continue;
    }
    if (text.startsWith('-')) return UNCLEAR_REASON;
    break;
  }
  const sub = args[i];
  // Only options (npm -v, pnpm --help) or nothing at all: no script or program runs.
  if (sub === undefined) return ctx.open ? UNCLEAR_REASON : null;
  if (sub.dynamic) return UNCLEAR_REASON;
  const rest = args.slice(i + 1);
  // Bare scripts (pnpm deploy:prod) run the same way as "run".
  if (sub.text.startsWith('deploy')) return DEPLOY_SCRIPT_REASON;
  if (isScriptSelector(sub.text)) return UNCLEAR_REASON;
  if (NPM_RUN_ALIASES.has(sub.text)) return npmRunReason(args, i + 1, wTakesValue);
  if (NPM_EXEC_ALIASES.has(sub.text)) {
    const command = rest[0]?.text === '--' ? rest.slice(1) : rest;
    if (command.length === 0 || (command[0]?.text ?? '').startsWith('-')) return UNCLEAR_REASON;
    return commandReason(command, deeper(ctx));
  }
  if (sub.text === 'explore') {
    // npm explore PKG -- COMMAND runs COMMAND inside the package. With no command it opens a shell.
    const dashes = rest.findIndex((w) => w.text === '--');
    const command = dashes === -1 ? rest.slice(1) : rest.slice(dashes + 1);
    return command.length === 0 ? UNCLEAR_REASON : commandReason(command, deeper(ctx));
  }
  // These take another package-manager command, which is checked the same way.
  if (NPM_RECURSIVE.has(sub.text)) return npmReason(rest, deeper(ctx));
  if (sub.text === 'workspace') return npmReason(rest.slice(1), deeper(ctx));
  if (sub.text === 'workspaces') {
    if (rest[0]?.text !== 'foreach') return npmReason(rest, deeper(ctx));
    const command = skipForeachFlags(rest.slice(1));
    return command === null ? UNCLEAR_REASON : npmReason(command, deeper(ctx));
  }
  return null;
}

function npmReason(args: readonly LexWord[], ctx: Ctx): string | null {
  if (ctx.depth > MAX_NESTING) return UNCLEAR_REASON;
  if (args.some((w) => w.text === 'publish')) return PUBLISH_REASON;
  const asValue = npmParse(args, ctx, true);
  // -w is a flag for pnpm and takes a value for npm: deny if either reading denies.
  if (asValue !== null || !args.some((w) => w.text === '-w')) return asValue;
  return npmParse(args, ctx, false);
}

function curlReason(args: readonly LexWord[]): string | null {
  if (args.some((w) => w.text.toLowerCase().includes('api.hetzner.cloud'))) return HETZNER_REASON;
  // A substitution, or URL globbing next to a host name, could hide the host.
  if (args.some((w) => w.expanded || (w.bracketed && w.text.includes('.')))) return UNCLEAR_REASON;
  return null;
}

function commandReason(words: readonly LexWord[], ctx: Ctx): string | null {
  if (ctx.depth > MAX_NESTING) return UNCLEAR_REASON;
  const found = findProgram(words, ctx);
  if (found.kind === 'reason') return found.reason;
  if (found.kind === 'inert') return null;
  if (found.kind === 'script') {
    // The string is read again by the inner shell, so s\sh is ssh. A dynamic one could be anything.
    return found.word.dynamic ? UNCLEAR_REASON : check(found.word.text, ctx.depth + 1);
  }
  const program = found.words[found.index];
  if (program === undefined) return found.lastWrapperUnfinished ? UNCLEAR_REASON : null;
  if (program.dynamic) return UNCLEAR_REASON;
  // A quoted command string, e.g. bash -c "ssh host": check it as a command line.
  if (/\s/.test(program.text)) return check(program.text, ctx.depth + 1);

  const name = programName(program.text);
  const args = found.words.slice(found.index + 1);
  const here: Ctx = { ...ctx, open: found.open };
  if (FAIL_CLOSED_PROGRAMS.has(name)) return UNCLEAR_REASON;
  if (name === 'eval') {
    // eval expands its arguments and then reads the result as commands, so an expansion can add any command.
    if (args.some((w) => w.dynamic)) return UNCLEAR_REASON;
    // eval eval eval ... would read the same text once for each eval.
    if (args.length === 0) return null;
    const evals = args.findIndex((w) => w.text !== 'eval');
    if (evals === -1 || evals >= MAX_NESTING) return UNCLEAR_REASON;
    return check(args.map((w) => w.text).join(' '), ctx.depth + 1);
  }
  if (name === 'source' || name === '.') {
    if (here.heredoc || args.some((w) => w.dynamic || STDIN_SCRIPT.test(w.text))) return UNCLEAR_REASON;
    return null;
  }
  if (name === 'shopt' && args.some((w) => w.text === 'expand_aliases')) return UNCLEAR_REASON;
  if (name === 'find' && args.some((w) => FIND_EXEC.has(w.text))) return UNCLEAR_REASON;
  if (name === 'git') return gitReason(args, here);
  if (DEPLOY_PROGRAMS.has(name)) return `Deploying is a Hub action; ${name} is not allowed in Build.`;
  if (name === 'gh') return ghReason(args, here);
  if (NPM_FAMILY.has(name)) return npmReason(args, here);
  if (CURL_FAMILY.has(name)) return curlReason(args);
  return null;
}

function check(command: string, depth: number): string | null {
  if (depth > MAX_NESTING) return UNCLEAR_REASON;
  const commands = lexShell(command, depth);
  const words = commands.flatMap((c) => c.words);
  if (words.some((w) => /git_config/i.test(w.text)) && words.some((w) => /alias\./i.test(w.text))) {
    return ALIAS_REASON;
  }
  // These point git at config files the Hub has not seen, and those can define aliases.
  if (words.some((w) => /^GIT_CONFIG_(?:GLOBAL|SYSTEM)=/.test(w.text))) return UNCLEAR_REASON;
  for (const { words: commandWords, heredoc } of commands) {
    const reason = commandReason(commandWords, { depth, heredoc, open: false });
    if (reason !== null) return reason;
  }
  return null;
}

/** Returns why a Bash command must not run in Build, or null. Deliberately conservative. */
export function deployDenyReason(command: string): string | null {
  try {
    return check(command, 0);
  } catch {
    // The lexer could not read it (unterminated quote, nesting too deep, too much work), or the stack ran out.
    return UNCLEAR_REASON;
  }
}

export function checkToolUse(cwd: string, toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') {
    try {
      return deployDenyReason(String(input.command ?? ''));
    } catch {
      return UNCLEAR_REASON;
    }
  }
  if (!EDIT_TOOLS.has(toolName)) return null;
  const target = resolve(cwd, String(input.file_path ?? input.notebook_path ?? ''));
  const rel = relative(cwd, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `Edits must stay inside the app checkout (${cwd}).`;
  }
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) return 'Do not edit .git directly.';
  return null;
}
