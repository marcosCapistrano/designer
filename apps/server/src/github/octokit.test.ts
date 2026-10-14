import { describe, expect, it } from 'vitest';
import { OctokitGitHub, REQUEST_TIMEOUT_MS } from './octokit.js';

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

/** A fetch stand-in that answers each request by its URL path with a canned JSON body. */
function routedFetch(routes: Record<string, unknown>) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const path = new URL(String(input)).pathname;
    if (!(path in routes)) return new Response(JSON.stringify({ message: `no route for ${path}` }), { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const RUNS_PATH = '/repos/o/r/commits/abc/check-runs';
const SUITES_PATH = '/repos/o/r/commits/abc/check-suites';
const GREEN_RUN = { name: 'ci', status: 'completed', conclusion: 'success' };

function suite(status: string, conclusion: string | null, runs = 1) {
  return { status, conclusion, latest_check_runs_count: runs };
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

  it('checkStatus maps check runs and reads the check suites too', async () => {
    const { fetchFn, calls } = routedFetch({
      [RUNS_PATH]: { total_count: 1, check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { total_count: 1, check_suites: [suite('completed', 'success')] },
    });
    const gh = new OctokitGitHub('tok', fetchFn);

    const status = await gh.checkStatus(repo, 'abc');

    expect(calls.map((call) => call.init?.method)).toEqual(['GET', 'GET']);
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([RUNS_PATH, SUITES_PATH]);
    expect(status).toEqual({
      state: 'success',
      checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
  });

  it('checkStatus is pending when every listed run is green but a check suite has not completed', async () => {
    for (const open of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const { fetchFn } = routedFetch({
        [RUNS_PATH]: { total_count: 1, check_runs: [GREEN_RUN] },
        [SUITES_PATH]: { total_count: 2, check_suites: [suite('completed', 'success'), suite(open, null)] },
      });

      const status = await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc');

      expect(status.state, open).toBe('pending');
      expect(status.checks).toEqual([GREEN_RUN]);
    }
  });

  it('checkStatus still reports a failed run as failure while a suite is open', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] },
      [SUITES_PATH]: { total_count: 1, check_suites: [suite('in_progress', null)] },
    });

    expect((await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc')).state).toBe('failure');
  });

  it('checkStatus is pending when no run is listed yet but a suite with runs is open', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 0, check_runs: [] },
      [SUITES_PATH]: { total_count: 1, check_suites: [suite('queued', null, 2)] },
    });

    expect((await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc')).state).toBe('pending');
  });

  it('checkStatus ignores a queued suite that has created no run, which some apps leave open for good', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 1, check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { total_count: 2, check_suites: [suite('completed', 'success'), suite('queued', null, 0)] },
    });

    expect((await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc')).state).toBe('success');
  });

  it('checkStatus is none when there are neither runs nor open suites', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 0, check_runs: [] },
      [SUITES_PATH]: { total_count: 0, check_suites: [] },
    });

    expect((await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc')).state).toBe('none');
  });

  it('checkStatus is pending when not every check run was read', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 101, check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { total_count: 1, check_suites: [suite('completed', 'success')] },
    });

    const status = await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc');

    expect(status.state).toBe('pending');
    expect(status.checks).toEqual([GREEN_RUN]);
  });

  it('checkStatus is pending when not every check suite was read', async () => {
    const { fetchFn } = routedFetch({
      [RUNS_PATH]: { total_count: 1, check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { total_count: 101, check_suites: [suite('completed', 'success')] },
    });

    expect((await new OctokitGitHub('tok', fetchFn).checkStatus(repo, 'abc')).state).toBe('pending');
  });

  it('checkStatus is pending when GitHub leaves out a total_count', async () => {
    const noRunsCount = routedFetch({
      [RUNS_PATH]: { check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { total_count: 1, check_suites: [suite('completed', 'success')] },
    });
    const noSuitesCount = routedFetch({
      [RUNS_PATH]: { total_count: 1, check_runs: [GREEN_RUN] },
      [SUITES_PATH]: { check_suites: [suite('completed', 'success')] },
    });

    expect((await new OctokitGitHub('tok', noRunsCount.fetchFn).checkStatus(repo, 'abc')).state).toBe('pending');
    expect((await new OctokitGitHub('tok', noSuitesCount.fetchFn).checkStatus(repo, 'abc')).state).toBe('pending');
  });

  describe('request timeout', () => {
    /** A fetch that never answers on its own and rejects when its signal aborts, as the real one does. */
    function hangingFetch() {
      const signals: (AbortSignal | undefined)[] = [];
      const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signals.push(init?.signal ?? undefined);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })) as typeof fetch;
      return { fetchFn, signals };
    }

    it('gives up on a request that GitHub does not answer', async () => {
      const { fetchFn, signals } = hangingFetch();
      const gh = new OctokitGitHub('tok', fetchFn, 30);

      const started = Date.now();
      await expect(gh.getPr(repo, 1)).rejects.toThrow();

      expect(Date.now() - started).toBeLessThan(5000);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0]?.aborted).toBe(true);
    });

    it('defaults to 30 seconds', () => {
      expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    });

    it('does not cut off an answer that arrives in time', async () => {
      const { fetchFn } = recordingFetch(200, []);
      const gh = new OctokitGitHub('tok', fetchFn, 5000);
      expect(await gh.findOpenPr(repo, 'build/x-1')).toBeNull();
    });
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
