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

/** Words that may precede the real program: wrappers, shells, and shell keywords. */
const LEADING_WORDS: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'exec',
  'command',
  'nohup',
  'time',
  'xargs',
  'bash',
  'sh',
  'zsh',
  '-c',
  '-lc',
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

function isLeadingWord(word: string): boolean {
  return ASSIGNMENT.test(word) || LEADING_WORDS.has(word) || word.startsWith('-');
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

function segmentReason(words: readonly string[]): string | null {
  let start = 0;
  while (start < words.length && isLeadingWord(words[start] ?? '')) start++;
  const first = words[start];
  if (first === undefined) return null;
  const program = basename(first).replace(/^\\+/, '');
  const args = words.slice(start + 1);

  if (program === 'git') {
    const [sub, ...later] = afterOptions(args, GIT_VALUE_FLAGS);
    if (sub === 'push') return GIT_PUSH_REASON;
    if ((sub === 'checkout' || sub === 'switch') && later.some((w) => w === 'main' || w === 'master')) {
      return MAIN_BRANCH_REASON;
    }
  }
  if (DEPLOY_PROGRAMS.has(program)) {
    return `Deploying is a Hub action; ${program} is not allowed in Build.`;
  }
  if (program === 'gh') {
    const [a = '', b = ''] = afterOptions(args, GH_VALUE_FLAGS);
    const isMerge = a === 'pr' && b === 'merge';
    const isWorkflowRun = a === 'workflow' && b === 'run';
    if (isMerge || isWorkflowRun || ['release', 'secret', 'api'].includes(a)) return GH_REASON;
  }
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
    if (args.includes('publish')) return PUBLISH_REASON;
    const [a = '', b = ''] = afterOptions(args, NPM_VALUE_FLAGS);
    if (a === 'deploy' || (a === 'run' && b.startsWith('deploy'))) return DEPLOY_SCRIPT_REASON;
  }
  if ((program === 'curl' || program === 'wget') && args.some((w) => w.includes('api.hetzner.cloud'))) {
    return HETZNER_REASON;
  }
  return null;
}

/** Returns why a Bash command must not run in Build, or null. Deliberately conservative. */
export function deployDenyReason(command: string): string | null {
  const s = command
    .replace(/["'`]/g, ' ')
    .replace(/\$\(/g, ';')
    .replace(/[()]/g, ';')
    .replace(/[<>]/g, ' ');
  for (const segment of s.split(/&&|\|\||[;|&\n]/)) {
    const trimmed = segment.trim();
    if (trimmed === '') continue;
    const reason = segmentReason(trimmed.split(/\s+/));
    if (reason !== null) return reason;
  }
  return null;
}

export function checkToolUse(cwd: string, toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Bash') return deployDenyReason(String(input.command ?? ''));
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'NotebookEdit') return null;
  const target = resolve(cwd, String(input.file_path ?? input.notebook_path ?? ''));
  const rel = relative(cwd, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `Edits must stay inside the app checkout (${cwd}).`;
  }
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) return 'Do not edit .git directly.';
  return null;
}
