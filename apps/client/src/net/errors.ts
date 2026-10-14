import { ApiError } from './api.js';

/** The server's text for an API error; a plain line for anything else, such as a network failure. */
export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Could not reach the hub. Try again.';
}
