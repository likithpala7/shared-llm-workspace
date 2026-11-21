import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import * as Y from 'yjs';
import { IGNORED_NAMES } from './config.js';
import { broadcast } from './events.js';
import { isEditable, readFileText, workspaceDir } from './files.js';
import { diskBaselineFor, hocuspocus, rememberDiskText, withDocument } from './sync.js';
import { applyExternalChange, applyMinimalDiff } from './textMerge.js';

export { applyExternalChange, applyMinimalDiff };

/**
 * Watches the workspace folder for changes made outside the editor — a terminal
 * running npm install, a formatter, the agent's own commands — and feeds them
 * into the Yjs documents as a minimal diff.
 */
const watchers = new Map<string, FSWatcher>();

/**
 * One file at a time. Two watcher events arriving together would both read the
 * same baseline and both apply the same change, duplicating it in the document.
 */
const queues = new Map<string, Promise<unknown>>();

function serialise(key: string, task: () => Promise<void>): void {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task).catch((error) => {
    console.error(`[watcher] ${key}:`, error);
  });
  queues.set(key, next);
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

async function fileChanged(workspaceId: string, relPath: string): Promise<void> {
  const documentName = `${workspaceId}/${relPath}`;
  // Only files someone has open need updating; the rest are read from disk the
  // next time they are opened.
  if (!hocuspocus.documents.has(documentName)) return;

  let text: string;
  try {
    const abs = path.join(workspaceDir(workspaceId), relPath);
    if (!isEditable(abs)) return;
    text = readFileText(workspaceId, relPath);
  } catch {
    return;
  }

  const base = diskBaselineFor(workspaceId, relPath);

  await withDocument(workspaceId, relPath, (ytext) => {
    if (base === undefined) {
      applyMinimalDiff(ytext, text);
      return;
    }
    // A no-op when the change came from our own debounced write, which is how
    // the echo loop is avoided.
    applyExternalChange(ytext, base, text);
  });

  // Only now is this change accounted for — but if a debounced editor write
  // landed while we were applying, that newer text is the real baseline and
  // must not be rolled back to what we read.
  if (diskBaselineFor(workspaceId, relPath) === base) {
    rememberDiskText(workspaceId, relPath, text);
  }
}

export function startWatching(workspaceId: string): void {
  if (watchers.has(workspaceId)) return;

  const root = workspaceDir(workspaceId);
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (candidate) =>
      candidate.split(path.sep).some((segment) => IGNORED_NAMES.has(segment)),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');

  const changed = (file: string) => {
    const rel = relative(file);
    serialise(`${workspaceId}/${rel}`, () => fileChanged(workspaceId, rel));
  };

  watcher.on('change', changed);
  watcher.on('add', (file) => {
    broadcast(workspaceId, { type: 'files_changed' });
    changed(file);
  });
  watcher.on('unlink', () => broadcast(workspaceId, { type: 'files_changed' }));
  watcher.on('addDir', () => broadcast(workspaceId, { type: 'files_changed' }));
  watcher.on('unlinkDir', () => broadcast(workspaceId, { type: 'files_changed' }));

  watchers.set(workspaceId, watcher);
  console.log(`[watcher] watching ${root}`);
}

export async function stopWatching(workspaceId: string): Promise<void> {
  const watcher = watchers.get(workspaceId);
  if (!watcher) return;
  watchers.delete(workspaceId);
  await watcher.close();
}
