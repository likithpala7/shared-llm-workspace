import fs from 'node:fs';
import path from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { YJS_STATE_DIR } from './config.js';
import { verifyToken } from './auth.js';
import { queries } from './db.js';
import { isEditable, readFileText, resolveInWorkspace, writeFileTextIfChanged } from './files.js';

/** Every open file is one Yjs document named `<workspaceId>/<relative path>`. */
export const Y_TEXT_KEY = 'content';

/**
 * The text each document last had on disk, as far as this server knows. The
 * watcher needs it to tell what a terminal actually changed, as opposed to what
 * the file now contains — the difference is anything typed but not yet written.
 */
const diskBaseline = new Map<string, string>();

export function diskBaselineFor(workspaceId: string, relPath: string): string | undefined {
  return diskBaseline.get(`${workspaceId}/${relPath}`);
}

export function rememberDiskText(workspaceId: string, relPath: string, text: string): void {
  diskBaseline.set(`${workspaceId}/${relPath}`, text);
}

export function parseDocumentName(documentName: string): { workspaceId: string; relPath: string } {
  const slash = documentName.indexOf('/');
  if (slash <= 0 || slash === documentName.length - 1) {
    throw new Error(`bad document name: ${documentName}`);
  }
  return {
    workspaceId: documentName.slice(0, slash),
    relPath: documentName.slice(slash + 1),
  };
}

function stateFile(workspaceId: string, relPath: string): string {
  return path.join(YJS_STATE_DIR, workspaceId, `${relPath}.bin`);
}

/**
 * Saves the CRDT state. Called on load as well as on every store: a file nobody
 * has edited yet still needs its state on disk, or a restart would seed a second
 * copy of the text into documents that open tabs are still holding.
 */
function saveState(document: Y.Doc, workspaceId: string, relPath: string): void {
  const saved = stateFile(workspaceId, relPath);
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, Y.encodeStateAsUpdate(document));
}

export const hocuspocus = new Hocuspocus({
  name: 'shared-llm-workspace',
  // Writes to disk settle 600ms after the last keystroke, and at least every
  // 3s while someone keeps typing.
  debounce: 600,
  maxDebounce: 3000,
  quiet: true,

  async onAuthenticate({ token, documentName }) {
    const { workspaceId, relPath } = parseDocumentName(documentName);

    // An explicit token only — never the cookie. A cookie is sent by the
    // browser on any cross-site WebSocket too, so accepting one here would let
    // another site open a socket as the visitor and read their files.
    const userId = verifyToken(token);
    const user = userId ? queries.getUser.get(userId) : null;
    if (!user) throw new Error('not signed in');
    if (!queries.getMembership.get(user.id, workspaceId)) throw new Error('not a member');

    const abs = resolveInWorkspace(workspaceId, relPath);
    if (!fs.existsSync(abs)) throw new Error('no such file');
    if (!isEditable(abs)) throw new Error('file is not editable');

    // Available to later hooks as `context`.
    return { userId: user.id, displayName: user.display_name, workspaceId, relPath };
  },

  async onLoadDocument({ document, documentName }) {
    const { workspaceId, relPath } = parseDocumentName(documentName);
    const ytext = document.getText(Y_TEXT_KEY);
    const saved = stateFile(workspaceId, relPath);
    const onDisk = readFileText(workspaceId, relPath);

    if (fs.existsSync(saved)) {
      // Resume the document we had before, so clients that are still holding it
      // merge with it instead of appending a second copy of the text.
      Y.applyUpdate(document, fs.readFileSync(saved));
      if (ytext.toString() !== onDisk) {
        // The file changed on disk while this server was not running; the file
        // wins. Milestone 4 replaces this with a minimal diff from the watcher.
        ytext.delete(0, ytext.length);
        if (onDisk.length > 0) ytext.insert(0, onDisk);
        saveState(document, workspaceId, relPath);
      }
      rememberDiskText(workspaceId, relPath, onDisk);
      return document;
    }

    // First time anyone opens this file: seed it from disk.
    if (ytext.length === 0 && onDisk.length > 0) ytext.insert(0, onDisk);
    saveState(document, workspaceId, relPath);
    rememberDiskText(workspaceId, relPath, onDisk);
    return document;
  },

  async onStoreDocument({ document, documentName }) {
    const { workspaceId, relPath } = parseDocumentName(documentName);
    const text = document.getText(Y_TEXT_KEY).toString();
    writeFileTextIfChanged(workspaceId, relPath, text);
    rememberDiskText(workspaceId, relPath, text);
    saveState(document, workspaceId, relPath);
  },
});

/**
 * Opens a server-side connection to one document and runs `fn` inside a Yjs
 * transaction. This is how the agent edits files: it joins the same documents
 * as every browser tab, so its changes arrive as ordinary CRDT updates while
 * people are typing, rather than as a whole-file overwrite.
 */
export async function withDocument<T>(
  workspaceId: string,
  relPath: string,
  fn: (ytext: Y.Text) => T,
): Promise<T> {
  const connection = await hocuspocus.openDirectConnection(`${workspaceId}/${relPath}`, {
    agent: true,
  });
  let result!: T;
  try {
    await connection.transact((document) => {
      result = fn(document.getText(Y_TEXT_KEY));
    });
  } finally {
    await connection.disconnect();
  }
  return result;
}

/** The live text if the document is open, otherwise null. */
export function loadedDocumentText(workspaceId: string, relPath: string): string | null {
  const document = hocuspocus.documents.get(`${workspaceId}/${relPath}`);
  return document ? document.getText(Y_TEXT_KEY).toString() : null;
}
