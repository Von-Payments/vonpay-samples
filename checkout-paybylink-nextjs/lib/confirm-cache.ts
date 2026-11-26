/**
 * A short memory of what the API said about a session, for the confirm page.
 *
 * The confirm page is public, and every view of it would otherwise make one
 * authenticated read on your key. So views of one session within
 * CONFIRM_CACHE_MS share one read, and views that arrive while a read is
 * running wait for that read.
 *
 * - Short on purpose: a payment that was still pending can finish, and a paid
 *   one can be refunded. No answer is kept longer than CONFIRM_CACHE_MS, so a
 *   pending answer is never held as if it were final.
 * - A FAILED read is not kept: the next view asks again.
 * - At most CONFIRM_CACHE_CAP sessions; the oldest goes first.
 *
 * ⚠ Per process, and not a rate limit: rate-limit the confirm page too.
 *
 * This file is identical in checkout-nextjs, checkout-paybylink-nextjs and
 * platform-integrator-nextjs.
 */
export const CONFIRM_CACHE_MS = 5_000;
export const CONFIRM_CACHE_CAP = 1_000;

const holder = globalThis as typeof globalThis & {
  __vonpaySampleConfirmCache?: Map<string, { at: number; read: Promise<unknown> }>;
};
const cache = (holder.__vonpaySampleConfirmCache ??= new Map<string, { at: number; read: Promise<unknown> }>());

/**
 * `read()`, or the answer another view of the same `key` got a moment ago. Make
 * the key from everything the answer depends on: the session id, and whose key
 * read it.
 */
export function readOnce<T>(key: string, read: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < CONFIRM_CACHE_MS) return hit.read as Promise<T>;
  cache.delete(key);
  if (cache.size >= CONFIRM_CACHE_CAP) {
    // Forget the oldest (a Map iterates in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const entry = { at: now, read: read() };
  cache.set(key, entry);
  entry.read.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.read;
}
