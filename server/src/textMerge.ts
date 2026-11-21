/**
 * Merging text that changed on disk into a document that may have moved on.
 *
 * Kept free of Yjs internals, chokidar and the server so it can be tested on
 * its own — this is the subtlest logic in the project and has produced three
 * real bugs: lost keystrokes, duplicated keystrokes, and a fallback that
 * silently replaced unsaved typing with whatever the file happened to hold.
 */

/** The minimum interface these functions need: a Yjs text, or a stand-in. */
export type EditableText = {
  toString(): string;
  delete(index: number, length: number): void;
  insert(index: number, text: string): void;
};

type Change = { at: number; removed: number; inserted: string };

/** How much surrounding text must match for a change to be placed confidently. */
const CONTEXT = 48;

/** The one contiguous region in which two strings differ. */
function diffRegion(before: string, after: string): Change | null {
  if (before === after) return null;

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { at: start, removed: endBefore - start, inserted: after.slice(start, endAfter) };
}

/**
 * Where does a change computed against `base` belong in `target`, which has
 * moved on? Anchored by the text on both sides, since an insertion removes
 * nothing and so proves nothing about its own position. Null when the two have
 * diverged in the same place.
 */
function locate(target: string, base: string, change: Change): number | null {
  const removedText = base.slice(change.at, change.at + change.removed);
  const suffixLength = base.length - (change.at + change.removed);
  const before = base.slice(Math.max(0, change.at - CONTEXT), change.at);
  const after = base.slice(change.at + change.removed, change.at + change.removed + CONTEXT);

  // Line it up against whichever side of the change still matches.
  for (const at of [change.at, target.length - suffixLength - change.removed]) {
    if (at < 0 || at + change.removed > target.length) continue;
    if (target.slice(at, at + change.removed) !== removedText) continue;
    if (before && !target.slice(0, at).endsWith(before)) continue;
    if (after && !target.slice(at + change.removed).startsWith(after)) continue;
    return at;
  }
  return null;
}

function withChangeAt(target: string, at: number, change: Change): string {
  return target.slice(0, at) + change.inserted + target.slice(at + change.removed);
}

/**
 * Replaces only the part that differs, so a person's cursor and any concurrent
 * typing elsewhere in the file survive. Used when there is no baseline to
 * compare against, where the file is simply the truth.
 */
export function applyMinimalDiff(ytext: EditableText, next: string): boolean {
  const change = diffRegion(ytext.toString(), next);
  if (!change) return false;
  if (change.removed > 0) ytext.delete(change.at, change.removed);
  if (change.inserted.length > 0) ytext.insert(change.at, change.inserted);
  return true;
}

/**
 * Applies what changed on disk to a document that may contain unsaved typing.
 * `base` is the text we last saw on disk, so anything in the document that is
 * not in `base` is unsaved and must survive.
 *
 * Three outcomes, in order of preference:
 *  1. The disk change can be placed in the document — apply it there.
 *  2. It cannot, but the unsaved typing can be replayed onto the new file —
 *     rebuild from the file and put the typing back.
 *  3. Both changed the same region — keep what the person typed, and let the
 *     next write reconcile. Their keystrokes cannot be recovered; the file's
 *     change usually can (a formatter runs again, a build rewrites its output).
 */
export function applyExternalChange(ytext: EditableText, base: string, next: string): boolean {
  const current = ytext.toString();
  if (current === next) return false;

  const diskChange = diffRegion(base, next);
  if (!diskChange) return false;

  const at = locate(current, base, diskChange);
  if (at !== null) {
    if (diskChange.removed > 0) ytext.delete(at, diskChange.removed);
    if (diskChange.inserted.length > 0) ytext.insert(at, diskChange.inserted);
    return true;
  }

  const unsaved = diffRegion(base, current);
  if (unsaved) {
    const where = locate(next, base, unsaved);
    if (where !== null) return applyMinimalDiff(ytext, withChangeAt(next, where, unsaved));
  }

  return false;
}
