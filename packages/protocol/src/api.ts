/** Build task lifecycle. `merged` and `closed` are terminal; the rest are open. */
export type BuildTaskStatus = 'working' | 'verifying' | 'pushing' | 'review' | 'no_changes' | 'failed' | 'queued' | 'merged' | 'closed';

export const OPEN_TASK_STATUSES: readonly BuildTaskStatus[] = ['working', 'verifying', 'pushing', 'review', 'no_changes', 'failed', 'queued'];

export function isOpenTask(status: BuildTaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}

export type CiState = 'none' | 'pending' | 'success' | 'failure';

export type BuildMessageKind = 'user' | 'assistant' | 'tool' | 'status' | 'error';

export interface BuildMessage {
  id: number;
  app: string;
  taskId: number | null;
  kind: BuildMessageKind;
  text: string;
  at: number;
}

export interface BuildTask {
  id: number;
  app: string;
  title: string;
  branch: string;
  base: string;
  status: BuildTaskStatus;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  ci: CiState;
  mergeSha: string | null;
  error: string | null;
  retryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BuildState {
  running: boolean;
  task: BuildTask | null;
  messages: BuildMessage[];
}

export interface AppSummary {
  name: string;
  adopted: boolean;
  manifestError: string | null;
  buildStatus: BuildTaskStatus | null;
  running: boolean;
}

export interface LoginRequest {
  passphrase: string;
}

export interface SendBuildRequest {
  text: string;
}

export interface TaskResponse {
  task: BuildTask;
}

export interface StopResponse {
  stopped: boolean;
}

export interface ApiErrorBody {
  error: string;
}
