import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { can, currentUser, setSessionCookie, signToken } from './auth.js';
import { PORT, REPO_ROOT, WORKSPACES_DIR, isAllowedOrigin } from './config.js';
import { queries } from './db.js';
import {
  cancelRequest,
  enqueueRequest,
  listThread,
  resumeQueuesOnStartup,
  stopRunningTurn,
} from './aiThread.js';
import { decide, expirePendingOnStartup, listToolCalls } from './approvals.js';
import { chatWss, listChat } from './chat.js';
import { startReaper } from './container.js';
import { preflight } from './preflight.js';
import { llm } from './llm.js';
import { LIMITS, allow, retryAfterSeconds } from './rateLimit.js';
import { currentSummary, verbatimMessages, verbatimTokens } from './summaries.js';
import { broadcast, eventsWss, onlineIn } from './events.js';
import { terminalWss } from './terminals.js';
import { startWatching } from './watcher.js';
import { createEmptyFile, listTree, seedWorkspace } from './files.js';
import { hocuspocus } from './sync.js';

fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

preflight();

const app = express();
// Behind a reverse proxy, req.ip must come from X-Forwarded-For or every
// caller looks like the proxy and shares one rate-limit bucket.
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
// Large enough for a long request or a file the agent writes, small enough
// that nobody can post a gigabyte at us.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // no embedding, so no clickjacking
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '1mb' }));

/** Refuses a caller who is over their allowance, with a Retry-After. */
function overLimit(
  res: express.Response,
  key: string,
  limit: { max: number; windowMs: number },
): boolean {
  if (allow(key, limit.max, limit.windowMs)) return false;
  res.setHeader('Retry-After', String(retryAfterSeconds(key)));
  res.status(429).json({ error: 'too many requests; slow down' });
  return true;
}

/**
 * Body-parser failures land here. Without this, Express answers with an HTML
 * error page, which breaks every client that expects JSON.
 */
app.use((
  error: Error & { status?: number; type?: string },
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (!error) return next();
  const status = error.status ?? 500;
  if (status === 413) return res.status(413).json({ error: 'request is too large' });
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'body is not valid JSON' });
  }
  console.error('[http]', error);
  res.status(status).json({ error: status === 500 ? 'internal error' : error.message });
});

const newId = () => crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('base64url');
const now = () => new Date().toISOString();

function createUser(displayName: string) {
  const id = newId();
  queries.insertUser.run(id, displayName, now());
  return queries.getUser.get(id)!;
}

/** The caller, reusing the identity in the Bearer token or cookie if there is one. */
function identify(req: express.Request, displayName: string) {
  const existing = currentUser(req);
  if (existing) {
    if (existing.display_name !== displayName) {
      queries.renameUser.run(displayName, existing.id);
    }
    return queries.getUser.get(existing.id)!;
  }
  return createUser(displayName);
}

function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 40);
  return name.length > 0 ? name : null;
}

const startedAt = Date.now();

/**
 * Unauthenticated, and deliberately boring: whether the server is up, and
 * which model provider it would use. No key material, no counts, nothing a
 * stranger could act on. Deploys watch this; tests read `provider` to refuse
 * to run model-dependent checks against the stub.
 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    provider: llm().name,
    usingRealModel: !llm().name.startsWith('stub'),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  // The token mirrors the cookie, so a fresh tab can bootstrap its identity.
  res.json({ id: user.id, displayName: user.display_name, token: signToken(user.id) });
});

/** Create a workspace and join it as owner. */
app.post('/api/workspaces', (req, res) => {
  if (overLimit(res, `create:${req.ip}`, LIMITS.createWorkspace)) return;
  const displayName = cleanDisplayName(req.body?.displayName);
  if (!displayName) return res.status(400).json({ error: 'displayName is required' });
  const name = cleanDisplayName(req.body?.name) ?? 'Workspace';

  const user = identify(req, displayName);
  const id = newId();
  const inviteToken = newToken();
  queries.insertWorkspace.run(id, name, inviteToken, now());
  queries.insertMembership.run(user.id, id, 'owner');
  seedWorkspace(id);

  setSessionCookie(res, user.id);
  res.json({
    workspace: { id, name, inviteToken },
    user: { id: user.id, displayName: user.display_name },
    token: signToken(user.id),
  });
});

/** What an invite link points at, before anyone picks a name. */
app.get('/api/invites/:token', (req, res) => {
  const workspace = queries.getWorkspaceByToken.get(req.params.token);
  if (!workspace) return res.status(404).json({ error: 'invite not found' });
  res.json({ workspace: { id: workspace.id, name: workspace.name } });
});

/** Join by invite link with a display name. */
app.post('/api/invites/:token/join', (req, res) => {
  if (overLimit(res, `join:${req.ip}`, LIMITS.join)) return;
  const workspace = queries.getWorkspaceByToken.get(req.params.token);
  if (!workspace) return res.status(404).json({ error: 'invite not found' });

  const displayName = cleanDisplayName(req.body?.displayName);
  if (!displayName) return res.status(400).json({ error: 'displayName is required' });

  // `asNewUser` lets a second tab of the same browser act as a second person.
  const user = req.body?.asNewUser ? createUser(displayName) : identify(req, displayName);
  queries.insertMembership.run(user.id, workspace.id, 'member');
  broadcast(workspace.id, { type: 'members_changed' });

  setSessionCookie(res, user.id);
  res.json({
    workspace: { id: workspace.id, name: workspace.name, inviteToken: workspace.invite_token },
    user: { id: user.id, displayName: user.display_name },
    token: signToken(user.id),
  });
});

app.get('/api/workspaces/:id', (req, res) => {
  const user = currentUser(req);
  const workspace = queries.getWorkspace.get(req.params.id);
  if (!workspace) return res.status(404).json({ error: 'workspace not found' });
  if (!can(user, 'read_workspace', workspace.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  // Terminals and the agent both change files behind Yjs's back.
  startWatching(workspace.id);

  res.json({
    workspace: { id: workspace.id, name: workspace.name, inviteToken: workspace.invite_token },
    members: queries.listMembers.all(workspace.id).map((m) => ({
      id: m.id,
      displayName: m.display_name,
      role: m.role,
    })),
  });
});

app.get('/api/workspaces/:id/files', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'read_workspace', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  res.json({ tree: listTree(req.params.id) });
});

app.post('/api/workspaces/:id/files', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'edit_files', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  const relPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (!relPath) return res.status(400).json({ error: 'path is required' });
  try {
    createEmptyFile(req.params.id, relPath);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
  broadcast(req.params.id, { type: 'files_changed' });
  res.json({ path: relPath });
});


// ---- Team chat -------------------------------------------------------------
// People talking to people. The agent has no read path to any of this.

app.get('/api/workspaces/:id/chat', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'read_workspace', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  res.json({ messages: listChat(req.params.id), online: onlineIn(req.params.id) });
});

// ---- AI thread -------------------------------------------------------------
// Every message posted here is a request. One per turn, in arrival order.

app.get('/api/workspaces/:id/ai', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'read_workspace', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  res.json({ messages: listThread(req.params.id), toolCalls: listToolCalls(req.params.id) });
});

app.post('/api/workspaces/:id/ai', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'edit_files', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required' });
  if (content.length > 20_000) {
    return res.status(400).json({ error: 'request is too long (20,000 characters max)' });
  }
  // The only endpoint that spends money.
  if (overLimit(res, `ai:${user!.id}`, LIMITS.aiRequest)) return;
  res.json({ message: enqueueRequest(req.params.id, user!.id, content) });
});

/** Debug view: what the model is actually carrying for this workspace. */
app.get('/api/workspaces/:id/summary', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'read_workspace', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  res.json({
    summary: currentSummary(req.params.id),
    verbatimMessages: verbatimMessages(req.params.id).length,
    verbatimTokens: verbatimTokens(req.params.id),
  });
});

/** A sender cancels their own request, while it is still queued. */
app.post('/api/workspaces/:id/ai/:messageId/cancel', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'edit_files', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  const cancelled = cancelRequest(req.params.messageId, user!.id);
  if (!cancelled) return res.status(409).json({ error: 'not your queued request' });
  res.json({ ok: true });
});

/**
 * Approve or deny a command the agent wants to run. Any member may decide, and
 * the first click wins — a second one gets 409.
 */
app.post('/api/workspaces/:id/tool-calls/:callId/:decision', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'approve_command', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }

  const decision = req.params.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return res.status(400).json({ error: 'decision must be approve or deny' });
  }

  const applied = decide(
    req.params.callId,
    user!,
    req.params.id,
    decision === 'approve' ? 'approved' : 'denied',
  );
  if (!applied) return res.status(409).json({ error: 'already decided' });
  res.json({ ok: true });
});

/** Any member can stop the turn that is running. */
app.post('/api/workspaces/:id/ai-stop', (req, res) => {
  const user = currentUser(req);
  if (!can(user, 'edit_files', req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  res.json({ stopped: stopRunningTurn(req.params.id) });
});

// Serve the built client when there is one (production); in dev, Vite does it.
const clientDist = path.join(REPO_ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const server = http.createServer(app);

// Yjs sync on /sync, workspace events on /events, shells on /terminal, and
// team chat on its own channel at /chat.
const syncWss = new WebSocketServer({ noServer: true });
syncWss.on('connection', (socket, request) => {
  hocuspocus.handleConnection(socket, request);
});

server.on('upgrade', (request, socket, head) => {
  // Same-origin policy does not cover WebSockets: without this, any page the
  // visitor opens could connect here carrying their cookies.
  if (!isAllowedOrigin(request.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const wss = pathname === '/sync' || pathname.startsWith('/sync/')
    ? syncWss
    : pathname === '/events'
      ? eventsWss
      : pathname === '/terminal'
        ? terminalWss
        : pathname === '/chat'
          ? chatWss
          : null;
  if (!wss) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  expirePendingOnStartup();
  resumeQueuesOnStartup();
  startReaper();
});
