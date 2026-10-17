import type {
  ApiErrorBody,
  AppSummary,
  BuildState,
  BuildTask,
  LoginRequest,
  SendBuildRequest,
  StopResponse,
  TaskResponse,
  ImportRequest, ImportResponse, DesignSummary,
  NodeSelection, DesignSelection, DesignEditResult,
  DesignChatState, DesignChatResult,
  SourcePreviewState, SourcePreviewResult,
  CanvasFrame,
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
  /** How long session() waits for the hub before it gives up. Default 10 s. */
  sessionTimeoutMs?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
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
  private readonly sessionTimeoutMs: number;

  constructor(opts: ApiClientOptions = {}) {
    // Wrapped so the browser's fetch is never invoked with the ApiClient as `this`.
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.onUnauthorized = opts.onUnauthorized ?? (() => {});
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 10_000;
  }

  /** For requests made outside this class (render files) that got a 401: tells the shell the session is gone. */
  reportUnauthorized(): void {
    this.onUnauthorized();
  }

  async login(passphrase: string): Promise<void> {
    const body: LoginRequest = { passphrase };
    await this.request('/login', { method: 'POST', body, checkAuth: false });
  }

  async logout(): Promise<void> {
    await this.request('/logout', { method: 'POST' });
  }

  /**
   * true when the session cookie is valid; 401 is false; other failures throw. A hub that never answers
   * rejects with a TimeoutError after sessionTimeoutMs, so the shell does not wait on "checking" forever.
   */
  async session(): Promise<boolean> {
    const res = await this.fetchFn('/api/session', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(this.sessionTimeoutMs),
    });
    if (res.ok) return true;
    if (res.status === 401) return false;
    throw await errorFrom(res);
  }

  apps(): Promise<AppSummary[]> {
    return this.json<AppSummary[]>('/apps');
  }

  designSummary(app: string): Promise<DesignSummary> { return this.json(`${appPath(app)}/design`); }
  importPages(app: string, body: ImportRequest): Promise<ImportResponse> {
    return this.json(`${appPath(app)}/design/import`, { method: 'POST', body });
  }
  retryPreview(app: string): Promise<{ warnings: string[] }> {
    return this.json(`${appPath(app)}/design/render`, { method: 'POST' });
  }
  designSelection(app: string, selection: NodeSelection): Promise<DesignSelection> {
    return this.json(`${appPath(app)}/design/selection`, { method: 'POST', body: selection });
  }
  editDesign(app: string, revision: string, ops: unknown[], selection?: NodeSelection): Promise<DesignEditResult> {
    return this.json(`${appPath(app)}/design/edits`, { method: 'POST', body: { revision, ops, selection } });
  }
  applyDesign(app: string, id: string): Promise<DesignEditResult> {
    return this.json(`${appPath(app)}/design/apply`, { method: 'POST', body: { id } });
  }
  cancelDesign(app: string, id: string): Promise<unknown> {
    return this.json(`${appPath(app)}/design/cancel`, { method: 'POST', body: { id } });
  }
  designHistory(app: string, revision: string, action: 'undo' | 'redo'): Promise<DesignEditResult> {
    return this.json(`${appPath(app)}/design/history`, { method: 'POST', body: { revision, action } });
  }
  designChat(app: string): Promise<DesignChatState> { return this.json(`${appPath(app)}/design/chat`); }
  sendDesign(app: string, text: string, selection?: NodeSelection): Promise<DesignChatResult> {
    return this.json(`${appPath(app)}/design/chat`, { method: 'POST', body: { text, selection } });
  }
  stopDesign(app: string): Promise<StopResponse> { return this.json(`${appPath(app)}/design/chat/stop`, { method: 'POST' }); }
  sourcePreview(app: string): Promise<SourcePreviewState> { return this.json(`${appPath(app)}/design/source-preview`); }
  generateSourcePreview(app: string, source: ImportRequest, text?:string): Promise<SourcePreviewResult> { return this.json(`${appPath(app)}/design/source-preview`, {method:'POST',body:{source,text}}); }
  applySourcePreview(app: string,id: string): Promise<ImportResponse> { return this.json(`${appPath(app)}/design/source-preview/apply`, {method:'POST',body:{id}}); }
  cancelSourcePreview(app: string,id: string): Promise<unknown> { return this.json(`${appPath(app)}/design/source-preview/cancel`, {method:'POST',body:{id}}); }
  stopSourcePreview(app: string): Promise<StopResponse> { return this.json(`${appPath(app)}/design/source-preview/stop`, {method:'POST'}); }

  /**
   * The app's canvas layout; the hub lays out pages that have no frames yet. `provisional` is set while some of
   * those were placed before their pages' heights were known, and so were not saved: ask again after a render.
   */
  async designFrames(app: string): Promise<{ frames: CanvasFrame[]; provisional: boolean }> {
    const res = await this.json<{ frames: CanvasFrame[]; provisional?: boolean }>(`${appPath(app)}/design/frames`);
    return { frames: res.frames, provisional: res.provisional === true };
  }

  /** Replaces the app's canvas layout; resolves with the layout the hub stored. */
  async saveDesignFrames(app: string, frames: readonly CanvasFrame[]): Promise<CanvasFrame[]> {
    const res = await this.json<{ frames: CanvasFrame[] }>(`${appPath(app)}/design/frames`, { method: 'PUT', body: { frames } });
    return res.frames;
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
    try {
      return (await res.json()) as T;
    } catch {
      // A 200 that is not JSON: a captive portal or a proxy's page, not the hub.
      throw new ApiError(res.status, 'The hub sent a reply that could not be read.');
    }
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
