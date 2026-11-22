import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_ORIGINS, COOKIE_SECURE, DATA_DIR } from './config.js';

/**
 * Checks the things that are easy to get wrong in a deployment and painful to
 * diagnose afterwards — a missing allowed origin looks like "the app loads but
 * nothing syncs", a default cookie secret looks like nothing at all.
 *
 * Refuses to start in production rather than running wrongly. In development
 * it only warns, because defaults there are deliberate.
 */
export function preflight(): void {
  const production = process.env.NODE_ENV === 'production';
  const problems: string[] = [];
  const warnings: string[] = [];

  if (ALLOWED_ORIGINS.length === 0) {
    problems.push(
      'ALLOWED_ORIGINS is not set. Only localhost may open a WebSocket, so the ' +
        'page will load and then fail to sync. Set it to your public origin, ' +
        'e.g. ALLOWED_ORIGINS=https://workspace.example.com',
    );
  }

  if (!process.env.COOKIE_SECRET) {
    problems.push(
      'COOKIE_SECRET is not set, so sessions are signed with the shared ' +
        'development value and anyone can forge one. Generate with: ' +
        'openssl rand -base64 32',
    );
  }

  if (!COOKIE_SECURE) {
    problems.push('COOKIE_SECURE is not true, so the session cookie may travel unencrypted.');
  }

  if (process.env.TRUST_PROXY !== 'true') {
    warnings.push(
      'TRUST_PROXY is not true. Behind a reverse proxy every caller looks like ' +
        'the proxy and shares one rate-limit bucket.',
    );
  }

  if (!path.isAbsolute(DATA_DIR)) {
    problems.push(`DATA_DIR must be an absolute path on a server; got "${DATA_DIR}".`);
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch {
    problems.push(`DATA_DIR is not writable: ${DATA_DIR}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY is not set: the agent will answer from the stub, not a model.');
  }

  for (const warning of warnings) console.warn(`[preflight] ${warning}`);

  if (problems.length === 0) return;

  const report = problems.map((problem) => `  - ${problem}`).join('\n');
  if (production) {
    console.error(`[preflight] refusing to start:\n${report}`);
    process.exit(1);
  }
  console.warn(`[preflight] not production, continuing anyway:\n${report}`);
}
