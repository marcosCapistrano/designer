import { describe, expect, it } from 'vitest';
import { OctokitGitHub } from './octokit.js';

const repo = { owner: 'o', repo: 'r' };

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

// A fetch stand-in that records every request and answers with a canned JSON response.
function recordingFetch(status: number, body: unknown) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? undefined;
}

describe('OctokitGitHub', () => {
  it('createPr posts to the pulls endpoint', async () => {
    const { fetchFn, calls } = recordingFetch(201, {
      number: 7,
      html_url: 'https://github.com/o/r/pull/7',
      state: 'open',
      merged: false,
      head: { sha: 'abc', ref: 'build/x-1' },
      base: { ref: 'main' },
    });
    const gh = new OctokitGitHub('tok', fetchFn);

    const pr = await gh.createPr(repo, { head: 'build/x-1', base: 'main', title: 'T', body: 'B' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.github.com/repos/o/r/pulls');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body))).toEqual({ head: 'build/x-1', base: 'main', title: 'T', body: 'B' });
    expect(headerValue(call?.init, 'authorization')).toBe('token tok');
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
      merged: false,
      mergeSha: null,
      headSha: 'abc',
      headRef: 'build/x-1',
      baseRef: 'main',
    });
  });

  it('findOpenPr filters by owner and branch', async () => {
    const { fetchFn, calls } = recordingFetch(200, [
      {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        state: 'open',
        merged: false,
        head: { sha: 'abc', ref: 'build/x-1' },
        base: { ref: 'main' },
      },
    ]);
    const gh = new OctokitGitHub('tok', fetchFn);

    const pr = await gh.findOpenPr(repo, 'build/x-1');

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/repos/o/r/pulls');
    expect(url.searchParams.get('head')).toBe('o:build/x-1');
    expect(url.searchParams.get('state')).toBe('open');
    expect(pr?.number).toBe(7);
  });

  it('findOpenPr returns null when no PR is open for the branch', async () => {
    const { fetchFn } = recordingFetch(200, []);
    const gh = new OctokitGitHub('tok', fetchFn);
    expect(await gh.findOpenPr(repo, 'build/x-1')).toBeNull();
  });

  it('checkStatus maps check runs', async () => {
    const { fetchFn, calls } = recordingFetch(200, {
      total_count: 1,
      check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
    const gh = new OctokitGitHub('tok', fetchFn);

    const status = await gh.checkStatus(repo, 'abc');

    expect(calls[0]?.init?.method).toBe('GET');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/repos/o/r/commits/abc/check-runs');
    expect(status).toEqual({
      state: 'success',
      checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
  });

  it('checkStatus is pending when not every check run was read', async () => {
    const { fetchFn } = recordingFetch(200, {
      total_count: 101,
      check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
    const gh = new OctokitGitHub('tok', fetchFn);

    const status = await gh.checkStatus(repo, 'abc');

    expect(status.state).toBe('pending');
    expect(status.checks).toEqual([{ name: 'ci', status: 'completed', conclusion: 'success' }]);
  });

  it('merge squashes and pins the sha', async () => {
    const { fetchFn, calls } = recordingFetch(200, {
      merged: true,
      sha: 'def',
      message: 'Pull Request successfully merged',
    });
    const gh = new OctokitGitHub('tok', fetchFn);

    const outcome = await gh.merge(repo, 7, 'abc');

    expect(calls[0]?.init?.method).toBe('PUT');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/repos/o/r/pulls/7/merge');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ merge_method: 'squash', sha: 'abc' });
    expect(outcome).toEqual({ merged: true, sha: 'def', message: 'Pull Request successfully merged' });
  });

  it('a refused merge is reported, not thrown', async () => {
    const { fetchFn } = recordingFetch(405, { message: 'Pull Request is not mergeable' });
    const gh = new OctokitGitHub('tok', fetchFn);

    const outcome = await gh.merge(repo, 7, 'abc');

    expect(outcome.merged).toBe(false);
    expect(outcome.sha).toBeNull();
    expect(outcome.message).toContain('not mergeable');
  });

  it('a merge refused with 409 is reported, not thrown', async () => {
    const { fetchFn } = recordingFetch(409, { message: 'Head branch was modified' });
    const gh = new OctokitGitHub('tok', fetchFn);

    const outcome = await gh.merge(repo, 7, 'abc');

    expect(outcome).toEqual({ merged: false, sha: null, message: expect.stringContaining('Head branch was modified') });
  });

  it('rethrows errors other than a refused merge', async () => {
    const { fetchFn } = recordingFetch(500, { message: 'Server Error' });
    const gh = new OctokitGitHub('tok', fetchFn);

    await expect(gh.merge(repo, 7, 'abc')).rejects.toThrow('Server Error');
  });
});
