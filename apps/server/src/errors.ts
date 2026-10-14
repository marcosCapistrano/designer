/**
 * The message of anything that was thrown, for a log line or a task error. It never throws itself: a value whose
 * String() or `message` getter throws (an object with a null prototype, say) gets a fixed text instead, so the
 * code that handles an error cannot turn it into a second one.
 */
export function errorText(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    if (typeof err === 'object' && err !== null) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return String(err);
  } catch {
    return 'Unprintable error';
  }
}
