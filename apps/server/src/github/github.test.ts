import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake.js';
import { type CheckRun, type CheckSuite, parseGitHubRemote, summarizeChecks } from './github.js';

const repo = { owner: 'o', repo: 'r' };

describe('summarizeChecks', () => {
  it('is none when there are no check runs', () => {
    expect(summarizeChecks([])).toBe('none');
  });

  it('is pending while a run is in progress', () => {
    expect(summarizeChecks([{ name: 'a', status: 'in_progress', conclusion: null }])).toBe('pending');
  });

  it('is success when every completed run succeeded, was skipped or was neutral', () => {
    const runs: CheckRun[] = [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'skipped' },
      { name: 'c', status: 'completed', conclusion: 'neutral' },
    ];
    expect(summarizeChecks(runs)).toBe('success');
  });

  it('is failure when a completed run failed, even with a queued run alongside it', () => {
    const runs: CheckRun[] = [
      { name: 'a', status: 'completed', conclusion: 'failure' },
      { name: 'b', status: 'queued', conclusion: null },
    ];
    expect(summarizeChecks(runs)).toBe('failure');
  });

  it('is failure when a completed run timed out', () => {
    expect(summarizeChecks([{ name: 'a', status: 'completed', conclusion: 'timed_out' }])).toBe('failure');
  });

  it('is pending when a run is completed without a conclusion', () => {
    expect(summarizeChecks([{ name: 'a', status: 'completed', conclusion: null }])).toBe('pending');
  });

  it('is pending when a completed run has a conclusion this code does not recognise', () => {
    expect(summarizeChecks([{ name: 'a', status: 'completed', conclusion: 'weird_new_value' }])).toBe('pending');
  });
});

describe('summarizeChecks with check suites', () => {
  const green: CheckRun[] = [{ name: 'a', status: 'completed', conclusion: 'success' }];
  const suite = (status: string, runCount = 1): CheckSuite => ({ status, conclusion: null, runCount });

  it('is pending while a suite has not completed, even when every listed run is green', () => {
    expect(summarizeChecks(green, [suite('queued')])).toBe('pending');
    expect(summarizeChecks(green, [suite('completed'), suite('in_progress')])).toBe('pending');
  });

  it('is success when every run is green and every suite completed', () => {
    expect(summarizeChecks(green, [suite('completed'), suite('completed')])).toBe('success');
    expect(summarizeChecks(green, [])).toBe('success');
  });

  it('is failure when a run failed, whatever the suites say', () => {
    const failing: CheckRun[] = [{ name: 'a', status: 'completed', conclusion: 'failure' }];
    expect(summarizeChecks(failing, [suite('queued')])).toBe('failure');
  });

  it('is pending, not none, when no run is listed but a suite with runs is open', () => {
    expect(summarizeChecks([], [suite('queued', 3)])).toBe('pending');
    expect(summarizeChecks([], [suite('completed', 3)])).toBe('none');
  });

  it('does not count a suite that has created no run', () => {
    expect(summarizeChecks(green, [suite('queued', 0)])).toBe('success');
    expect(summarizeChecks([], [suite('queued', 0)])).toBe('none');
  });
});

describe('parseGitHubRemote', () => {
  it('parses GitHub remotes in every supported form', () => {
    for (const url of [
      'git@github.com:o/r.git',
      'https://github.com/o/r',
      'https://github.com/o/r.git',
      'https://x-access-token:abc@github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
    ]) {
      expect(parseGitHubRemote(url), url).toEqual({ owner: 'o', repo: 'r' });
    }
  });

  it('returns null for local paths and other hosts', () => {
    expect(parseGitHubRemote('/tmp/origin.git')).toBeNull();
    expect(parseGitHubRemote('https://gitlab.com/o/r')).toBeNull();
  });
});

describe('FakeGitHub', () => {
  it('numbers PRs and finds them by branch', async () => {
    const gh = new FakeGitHub();
    const pr = await gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' });
    expect(pr).toEqual({
      number: 1,
      url: 'https://github.com/o/r/pull/1',
      state: 'open',
      merged: false,
      mergeSha: null,
      headSha: 'head-1',
      headRef: 'build/x-1',
      baseRef: 'main',
    });
    expect(await gh.findOpenPr(repo, 'build/x-1')).toEqual(pr);
    expect(await gh.findOpenPr(repo, 'build/other')).toBeNull();

    const second = await gh.createPr(repo, { head: 'build/x-2', base: 'main', title: 'T2', body: 'B2' });
    expect(second.number).toBe(2);
    await expect(gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' })).rejects.toThrow(
      'A pull request already exists for build/x-1',
    );
    await expect(gh.getPr(repo, 99)).rejects.toThrow('Not Found');
  });

  it('refuses a stale merge', async () => {
    const gh = new FakeGitHub();
    await gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' });
    gh.movePrHead(1, 'h2');
    const outcome = await gh.merge(repo, 1, 'h1');
    expect(outcome.merged).toBe(false);
    expect(gh.merges).toEqual([]);
  });

  it('merges an open PR at its pinned head and closes it', async () => {
    const gh = new FakeGitHub();
    await gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' });

    const outcome = await gh.merge(repo, 1, 'head-1');

    expect(outcome).toEqual({ merged: true, sha: 'merged-1', message: 'Merged' });
    expect(gh.merges).toEqual([{ number: 1, sha: 'head-1' }]);
    const pr = await gh.getPr(repo, 1);
    expect(pr).toMatchObject({ state: 'closed', merged: true, mergeSha: 'merged-1' });
    expect(await gh.findOpenPr(repo, 'build/x-1')).toBeNull();
  });

  it('holds CI pending while a check suite set on the fake has not completed', async () => {
    const gh = new FakeGitHub();
    gh.setChecks('h1', [{ name: 'a', status: 'completed', conclusion: 'success' }]);
    gh.setSuites('h1', [{ status: 'queued', conclusion: null, runCount: 1 }]);
    expect((await gh.checkStatus(repo, 'h1')).state).toBe('pending');

    gh.setSuites('h1', [{ status: 'completed', conclusion: 'success', runCount: 1 }]);
    expect((await gh.checkStatus(repo, 'h1')).state).toBe('success');
  });

  it('keeps pull requests apart by repo, as GitHub does', async () => {
    const gh = new FakeGitHub();
    const other = { owner: 'o', repo: 'other' };
    await gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' });

    await expect(gh.getPr(other, 1)).rejects.toThrow('Not Found');
    await expect(gh.merge(other, 1, 'head-1')).rejects.toThrow('Not Found');
    expect(await gh.findOpenPr(other, 'build/x-1')).toBeNull();
    // The same branch name may be open in the other repo too.
    await expect(gh.createPr(other, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' })).resolves.toMatchObject({
      number: 2,
    });
    expect(gh.merges).toEqual([]);
  });

  it('reports one in-progress run and then success when autoGreenAfter is 1', async () => {
    const gh = new FakeGitHub({ autoGreenAfter: 1 });
    expect((await gh.checkStatus(repo, 'h1')).state).toBe('pending');
    expect((await gh.checkStatus(repo, 'h1')).state).toBe('success');
  });
});
