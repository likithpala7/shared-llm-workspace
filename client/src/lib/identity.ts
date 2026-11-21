export type Identity = { token: string; userId: string; displayName: string };

/**
 * The session token also lives in a signed cookie, but the tab-scoped copy wins:
 * it lets two tabs of one browser act as two different people.
 */
const KEY = 'slw_identity';

export function loadIdentity(): Identity | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Identity;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity): void {
  sessionStorage.setItem(KEY, JSON.stringify(identity));
}

export function clearIdentity(): void {
  sessionStorage.removeItem(KEY);
}

/** A stable per-user cursor colour. */
export function colorFor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash}, 72%, 48%)`;
}
