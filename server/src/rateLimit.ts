/**
 * A small fixed-window limiter, held in memory.
 *
 * Not a defence against a determined attacker with many addresses — it is here
 * so that one person, or one runaway script, cannot exhaust the model budget
 * or fill the disk before anyone notices. A shared store comes with the
 * durable queue, when there is more than one server process.
 */
type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** True when the caller is still inside their allowance. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

export function retryAfterSeconds(key: string): number {
  const existing = windows.get(key);
  if (!existing) return 0;
  return Math.max(1, Math.ceil((existing.resetAt - Date.now()) / 1000));
}

/** Forget expired windows so the map cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}, 60_000).unref();

export const LIMITS = {
  /** Creating workspaces: cheap for us, but unbounded disk if left open. */
  createWorkspace: { max: Number(process.env.LIMIT_CREATE_WORKSPACE ?? 20), windowMs: 60 * 60 * 1000 },
  /** Joining: the invite token is the only secret, so slow down guessing. */
  join: { max: Number(process.env.LIMIT_JOIN ?? 30), windowMs: 60 * 60 * 1000 },
  /** Model requests: this is the one that costs money. */
  aiRequest: { max: Number(process.env.LIMIT_AI_REQUESTS ?? 40), windowMs: 10 * 60 * 1000 },
  /** Shells: each one is a process in the container. */
  terminal: { max: Number(process.env.LIMIT_TERMINALS ?? 20), windowMs: 10 * 60 * 1000 },
  /** Chat: generous, just not unbounded. */
  chat: { max: Number(process.env.LIMIT_CHAT ?? 120), windowMs: 60 * 1000 },
} as const;
