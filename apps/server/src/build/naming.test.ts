import { describe, expect, it } from 'vitest';
import { branchSlug, buildSystemPrompt, fixPrompt, prBody, prTitle, summarizeTool } from './naming.js';

describe('branch slugs', () => {
  it('uses the first six words and the task id', () => {
    expect(branchSlug('Add a dark-mode toggle to Settings!', 12)).toBe('add-a-dark-mode-toggle-to-12');
  });

  it('falls back to task when the prompt has no letters or digits', () => {
    expect(branchSlug('!!!', 5)).toBe('task-5');
  });

  it('ignores leading and repeated punctuation', () => {
    expect(branchSlug('--fix:  the (login) bug', 3)).toBe('fix-the-login-bug-3');
    expect(branchSlug('...and then some', 4)).toBe('and-then-some-4');
  });

  it('never ends the stem with a dash when the cut falls on a word boundary', () => {
    // 39 letters, a dash, then more: cutting at 40 characters leaves the dash last, and it is dropped.
    const slug = branchSlug(`${'a'.repeat(39)} bcd`, 8);
    expect(slug).toBe(`${'a'.repeat(39)}-8`);
  });

  it('keeps the slug within 40 characters', () => {
    expect(branchSlug('Implement the extraordinarily comprehensive internationalization subsystem now', 9)).toBe(
      'implement-the-extraordinarily-comprehens-9',
    );
  });
});

describe('pr titles', () => {
  it('uses the first line with collapsed whitespace', () => {
    expect(prTitle('  Fix   the\nlogin bug')).toBe('Fix the');
  });

  it('truncates long titles to 71 characters and an ellipsis', () => {
    expect(prTitle('a'.repeat(100))).toBe('a'.repeat(71) + '…');
  });

  it('uses a default title for an empty prompt', () => {
    expect(prTitle('')).toBe('Hub build task');
  });
});

describe('pr body', () => {
  it('lists the requests', () => {
    expect(prBody(['one', 'two\nlines'])).toBe(
      'Opened by the Hub Build area.\n\n## Requests\n\n1. one\n2. two lines\n',
    );
  });
});

describe('tool summaries', () => {
  it('shows the first line of a bash command', () => {
    expect(summarizeTool('Bash', { command: 'pnpm test\nmore' }, '/r')).toBe('$ pnpm test');
  });

  it('cuts long bash commands to 160 characters', () => {
    const summary = summarizeTool('Bash', { command: 'x'.repeat(200) }, '/r');
    expect(summary).toBe('$ ' + 'x'.repeat(160) + '…');
    expect(summary).toHaveLength(163);
  });

  it('shows file paths relative to the checkout when inside it', () => {
    expect(summarizeTool('Edit', { file_path: '/r/src/a.ts' }, '/r')).toBe('Edit src/a.ts');
  });

  it('shows absolute paths outside the checkout', () => {
    expect(summarizeTool('Read', { file_path: '/etc/hosts' }, '/r')).toBe('Read /etc/hosts');
  });

  it('shows search patterns', () => {
    expect(summarizeTool('Grep', { pattern: 'TODO' }, '/r')).toBe('Grep TODO');
    expect(summarizeTool('Glob', { pattern: 'src/**/*.ts' }, '/r')).toBe('Glob src/**/*.ts');
  });

  it('shows only the first line of a search pattern and cuts it to 160 characters', () => {
    expect(summarizeTool('Grep', { pattern: 'first\nsecond' }, '/r')).toBe('Grep first');
    const long = summarizeTool('Glob', { pattern: 'x'.repeat(500) }, '/r');
    expect(long).toBe(`Glob ${'x'.repeat(160)}…`);
  });

  it('shows the notebook path of a NotebookEdit and the file path of the file tools', () => {
    expect(summarizeTool('NotebookEdit', { notebook_path: '/r/analysis/n.ipynb' }, '/r')).toBe(
      'NotebookEdit analysis/n.ipynb',
    );
    expect(summarizeTool('Write', { file_path: '/r/a.ts' }, '/r')).toBe('Write a.ts');
    expect(summarizeTool('NotebookEdit', {}, '/r')).toBe('NotebookEdit');
  });

  it('shows only the name for other tools and odd input', () => {
    expect(summarizeTool('mcp__x__y', null, '/r')).toBe('mcp__x__y');
  });
});

describe('system prompt', () => {
  it('names the branch and forbids branch switches and pushes', () => {
    const prompt = buildSystemPrompt('build/x-1');
    expect(prompt).toContain('branch `build/x-1`');
    expect(prompt).toContain('Do not switch branches, push, merge or deploy');
  });
});

describe('fix prompt', () => {
  it('says the command timed out instead of quoting an exit code', () => {
    const prompt = fixPrompt(
      { name: 'test', cmd: 'pnpm test' },
      { ok: false, code: null, output: 'still running', timedOut: true, aborted: false },
    );
    expect(prompt).toContain('`pnpm test` (test) and it failed (timed out).');
    expect(prompt).not.toContain('exit code');
  });

  it('quotes the command and exit code, then the output', () => {
    const prompt = fixPrompt(
      { name: 'test', cmd: 'pnpm test' },
      { ok: false, code: 1, output: 'boom', timedOut: false, aborted: false },
    );
    expect(prompt).toContain('`pnpm test` (test) and it failed with exit code 1');
    expect(prompt.endsWith('boom')).toBe(true);
  });
});
