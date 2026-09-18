// Operator input for one membership credential: the handle the member is
// shown under, and nothing else. There are deliberately no scores, roles
// or reputation fields anywhere in the issuer.
export const HANDLE_MAX = 40;

export class HandleError extends Error {}
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\u202a-\u202e\u2066-\u2069]/u;

/**
 * Trims, then requires 1..40 characters (Unicode code points, which is
 * what the schema's maxLength counts) and no control characters. Line and
 * paragraph separators are refused too (KERIA's tunnel re-splits bodies
 * on them; demo2 DESIGN.md, bug 1), as are bidi overrides and lone surrogates.
 */
export function parseHandle(input: unknown): string {
  if (typeof input !== "string") throw new HandleError("handle must be a string");
  const handle = input.trim();
  const length = [...handle].length;
  if (length < 1) throw new HandleError("handle must not be empty");
  if (length > HANDLE_MAX) throw new HandleError(`handle must be at most ${HANDLE_MAX} characters`);
  if (CONTROL.test(handle)) throw new HandleError("handle must not contain control characters");
  return handle;
}

/** Accepts exactly `{handle}`. Anything else throws. */
export function parseSessionInput(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HandleError("expected an object with a handle");
  }
  for (const key of Object.keys(input)) {
    if (key !== "handle") throw new HandleError(`unexpected field "${key}"`);
  }
  return parseHandle((input as Record<string, unknown>).handle);
}
