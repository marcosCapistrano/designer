export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'done'; sessionId: string; ok: boolean; error?: string };

export interface RunOptions {
  cwd: string;
  prompt: string;
  resume?: string;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  systemPrompt?: string; // appended to Claude Code's own system prompt
  signal?: AbortSignal; // abort -> done { ok: false, error: 'aborted' }
}

/** run() never throws and always ends with exactly one 'done'. */
export interface ClaudeRunner {
  run(opts: RunOptions): AsyncIterable<AgentEvent>;
}

export const USAGE_LIMIT = 'usage_limit';

export function usageLimitError(resetsAtMs: number | null): string {
  return resetsAtMs === null ? USAGE_LIMIT : `${USAGE_LIMIT}:${resetsAtMs}`;
}

export function parseUsageLimit(error: string | undefined): { resetsAtMs: number | null } | null {
  if (error === USAGE_LIMIT) return { resetsAtMs: null };
  const match = /^usage_limit:(\d+)$/.exec(error ?? '');
  return match?.[1] === undefined ? null : { resetsAtMs: Number(match[1]) };
}
