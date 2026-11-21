import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, whether running from src/ (tsx) or dist/ (node). */
export const REPO_ROOT = path.resolve(here, '..', '..');

/**
 * Secrets and local settings live in .env at the repo root, which is gitignored.
 * Anything already set in the real environment wins, so `ANTHROPIC_API_KEY=… npm
 * run dev` still overrides the file. Names are logged on startup; values never
 * are.
 */
function loadEnvFile(): void {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  const before = new Set(Object.keys(process.env));
  process.loadEnvFile(envPath);
  const loaded = Object.keys(process.env).filter((key) => !before.has(key));
  if (loaded.length > 0) console.log(`.env supplied: ${loaded.join(', ')}`);
}

loadEnvFile();

export const PORT = Number(process.env.PORT ?? 3001);
// Resolved: Docker refuses a relative bind path, so a relative DATA_DIR
// would break terminals with a cryptic error far from the cause.
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data'));
export const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
export const DB_PATH = path.join(DATA_DIR, 'app.db');

/**
 * Yjs document state, kept outside the workspace folder so it never shows up in
 * the file tree or inside the container. Text still lives in the real file; this
 * is the CRDT history that lets a restarted server rejoin documents that open
 * tabs are still holding.
 */
export const YJS_STATE_DIR = path.join(DATA_DIR, 'yjs');

export const COOKIE_NAME = 'slw_session';
export const COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'dev-only-insecure-secret';

if (!process.env.COOKIE_SECRET) {
  console.warn('COOKIE_SECRET is not set; using the shared dev value. Set it in .env.');
}

/** Files above this size are listed in the tree but never loaded into Yjs. */
export const MAX_SYNC_FILE_BYTES = 1024 * 1024;

/** Directory and file names that never reach the editor or the file tree. */
export const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  '.cache',
]);
