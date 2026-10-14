import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BuildCommand, CommandResult } from './commands.js';

const SLUG_WORDS = 6;
const SLUG_MAX = 40;
const TITLE_MAX = 72;
const TOOL_COMMAND_MAX = 160;
const FIX_OUTPUT_TAIL = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Branch name stem for a Build task: the first words of the prompt plus the task id. */
export function branchSlug(prompt: string, id: number): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '')
    .slice(0, SLUG_WORDS);
  const slug = words.join('-').slice(0, SLUG_MAX).replace(/-$/, '');
  return `${slug === '' ? 'task' : slug}-${id}`;
}

/** Pull request title: the first line of the prompt, trimmed and shortened. */
export function prTitle(prompt: string): string {
  const firstLine = (prompt.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  if (firstLine === '') return 'Hub build task';
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

/** Pull request body listing every request in the build, one per line. */
export function prBody(prompts: readonly string[]): string {
  const items = prompts.map((prompt, i) => `${i + 1}. ${prompt.replace(/\s+/g, ' ').trim()}`);
  return `Opened by the Hub Build area.\n\n## Requests\n\n${items.join('\n')}\n`;
}

function displayPath(cwd: string, file: string): string {
  const absolute = resolve(cwd, file);
  const rel = relative(cwd, absolute);
  const inside = rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  return inside ? rel : absolute;
}

/** One-line description of a tool call for the Build activity feed. */
export function summarizeTool(name: string, input: unknown, cwd: string): string {
  if (!isRecord(input)) return name;
  switch (name) {
    case 'Bash': {
      const command = input.command;
      if (typeof command !== 'string') return name;
      const line = command.split('\n')[0] ?? '';
      const shown = line.length > TOOL_COMMAND_MAX ? `${line.slice(0, TOOL_COMMAND_MAX)}…` : line;
      return `$ ${shown}`;
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const file = input.file_path ?? input.notebook_path;
      if (typeof file !== 'string') return name;
      return `${name} ${displayPath(cwd, file)}`;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = input.pattern;
      if (typeof pattern !== 'string') return name;
      return `${name} ${pattern}`;
    }
    default:
      return name;
  }
}

/** System prompt for a Claude run in a Build task's checkout. */
export function buildSystemPrompt(branch: string): string {
  return [
    `You are Claude Code running inside the Hub, in this app's git checkout on branch \`${branch}\`.`,
    '- Stay on this branch. Do not switch branches, push, merge or deploy: the Hub pushes, opens the pull request and deploys after its own checks.',
    "- Make the change the user asks for, add or update tests, and run the project's typecheck and tests before you finish.",
    '- Commit your work with a clear message when you are done.',
    '- The user reads your replies on a tablet: keep them short and say what you changed.',
  ].join('\n');
}

/** Prompt sent back to Claude when a build command failed. */
export function fixPrompt(c: BuildCommand, r: CommandResult): string {
  const outcome = r.timedOut ? ' (timed out)' : ` with exit code ${r.code}`;
  return `The Hub ran \`${c.cmd}\` (${c.name}) and it failed${outcome}. Fix the cause, run it again yourself, and commit. Last output:\n\n${r.output.slice(-FIX_OUTPUT_TAIL)}`;
}
