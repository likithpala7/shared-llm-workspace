import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_NAMES, MAX_SYNC_FILE_BYTES, WORKSPACES_DIR } from './config.js';

export type TreeNode =
  | { type: 'dir'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; path: string; size: number; editable: boolean };

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.so', '.dylib', '.node',
]);

export function workspaceDir(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, workspaceId);
}

/** Resolves a workspace-relative path, refusing anything that escapes the folder. */
export function resolveInWorkspace(workspaceId: string, relPath: string): string {
  const root = workspaceDir(workspaceId);
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${relPath}`);
  }
  if (rel.split(path.sep).some((segment) => IGNORED_NAMES.has(segment))) {
    throw new Error(`path is ignored: ${relPath}`);
  }
  return abs;
}

function looksBinary(abs: string, size: number): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase())) return true;
  if (size === 0) return false;
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(1024, size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/** True when a file may be loaded into a Yjs document. */
export function isEditable(abs: string): boolean {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return false;
  if (stat.size > MAX_SYNC_FILE_BYTES) return false;
  return !looksBinary(abs, stat.size);
}

export function listTree(workspaceId: string): TreeNode[] {
  const root = workspaceDir(workspaceId);
  fs.mkdirSync(root, { recursive: true });

  const walk = (dir: string): TreeNode[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        nodes.push({ type: 'dir', name: entry.name, path: rel, children: walk(abs) });
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        nodes.push({
          type: 'file',
          name: entry.name,
          path: rel,
          size: stat.size,
          editable: stat.size <= MAX_SYNC_FILE_BYTES && !looksBinary(abs, stat.size),
        });
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  };

  return walk(root);
}

export function readFileText(workspaceId: string, relPath: string): string {
  const abs = resolveInWorkspace(workspaceId, relPath);
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Writes text to disk only when it differs from what is already there, so the
 * server's own writes never come back as fresh edits.
 */
export function writeFileTextIfChanged(workspaceId: string, relPath: string, text: string): boolean {
  const abs = resolveInWorkspace(workspaceId, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) {
    try {
      if (fs.readFileSync(abs, 'utf8') === text) return false;
    } catch {
      // Unreadable as utf8: fall through and overwrite.
    }
  }
  fs.writeFileSync(abs, text, 'utf8');
  return true;
}

export function createEmptyFile(workspaceId: string, relPath: string): void {
  createFile(workspaceId, relPath, '');
}

export function createFile(workspaceId: string, relPath: string, content: string): void {
  const abs = resolveInWorkspace(workspaceId, relPath);
  if (fs.existsSync(abs)) throw new Error('file already exists');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

export function fileExists(workspaceId: string, relPath: string): boolean {
  return fs.existsSync(resolveInWorkspace(workspaceId, relPath));
}

/** Every editable file in the workspace, as workspace-relative paths. */
export function listFilePaths(workspaceId: string): string[] {
  const walk = (nodes: TreeNode[]): string[] =>
    nodes.flatMap((node) =>
      node.type === 'dir' ? walk(node.children) : node.editable ? [node.path] : [],
    );
  return walk(listTree(workspaceId));
}

const SEED_FILES: Record<string, string> = {
  'README.md': `# Shared workspace

Open this file in two browser tabs and type in both. Edits merge through Yjs and
land on disk a moment later.
`,
  'notes.md': `# Scratch notes

- [ ] try typing here from two tabs at once
`,
};

export function seedWorkspace(workspaceId: string): void {
  const root = workspaceDir(workspaceId);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, content, 'utf8');
  }
}
