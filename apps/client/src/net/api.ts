import type {
  ApiErrorBody,
  AppSummary,
  BuildState,
  BuildTask,
  LoginRequest,
  SendBuildRequest,
  StopResponse,
  TaskResponse,
} from '@hub/protocol';

/** A non-OK API response. `message` is the server's `error` text when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  fetchFn?: FetchFn;
  /** Called on a 401 from any call except login and session. */
  onUnauthorized?: () => void;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** false skips onUnauthorized; only login uses it. */
  checkAuth?: boolean;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ApiErrorBody> | null;
    if (typeof body?.error === 'string') message = body.error;
  } catch {
    // Not JSON: keep the HTTP status text.
  }
  return new ApiError(res.status, message);
}

const appPath = (app: string): string => `/apps/${encodeURIComponent(app)}`;

/** Typed client for the hub's `/api` routes. Same-origin, cookie-authenticated. */
export class ApiClient {
  private readonly fetchFn: FetchFn;
  private readonly onUnauthorized: () => void;

  constructor(opts: ApiClientOptions = {}) {
    // Wrapped so the browser's fetch is never invoked with the ApiClient as `this`.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.onUnauthorized = opts.onUnauthorized ?? (() => {});
  }

  async login(passphrase: string): Promise<void> {
    const body: LoginRequest = { passphrase };
    await this.request('/login', { method: 'POST', body, checkAuth: false });
  }

  async logout(): Promise<void> {
    await this.request('/logout', { method: 'POST' });
  }

  /** true when the session cookie is valid; 401 is false; other failures throw. */
  async session(): Promise<boolean> {
    const res = await this.fetchFn('/api/session', { credentials: 'same-origin' });
    if (res.ok) return true;
    if (res.status === 401) return false;
    throw await errorFrom(res);
  }

  apps(): Promise<AppSummary[]> {
    return this.json<AppSummary[]>('/apps');
  }

  buildState(app: string, after?: number): Promise<BuildState> {
    const query = after === undefined ? '' : `?after=${after}`;
    return this.json<BuildState>(`${appPath(app)}/build${query}`);
  }

  async sendBuild(app: string, text: string): Promise<BuildTask> {
    const body: SendBuildRequest = { text };
    const res = await this.json<TaskResponse>(`${appPath(app)}/build/messages`, { method: 'POST', body });
    return res.task;
  }

  async stopBuild(app: string): Promise<boolean> {
    const res = await this.json<StopResponse>(`${appPath(app)}/build/stop`, { method: 'POST' });
    return res.stopped;
  }

  async merge(app: string, taskId: number): Promise<BuildTask> {
    const res = await this.json<TaskResponse>(`${appPath(app)}/build/tasks/${taskId}/merge`, { method: 'POST' });
    return res.task;
  }

  async closeTask(app: string, taskId: number): Promise<BuildTask> {
    const res = await this.json<TaskResponse>(`${appPath(app)}/build/tasks/${taskId}/close`, { method: 'POST' });
    return res.task;
  }

  private async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, opts);
    return (await res.json()) as T;
  }

  private async request(path: string, { method = 'GET', body, checkAuth = true }: RequestOptions = {}): Promise<Response> {
    const init: RequestInit = { method, credentials: 'same-origin' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchFn(`/api${path}`, init);
    if (res.ok) return res;
    if (res.status === 401 && checkAuth) this.onUnauthorized();
    throw await errorFrom(res);
  }
}
