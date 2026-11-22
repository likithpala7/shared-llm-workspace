// Hardening: the things that matter if this is reachable from the internet.
import WebSocket from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { API, WS_ORIGIN, call, reporter, sleep, twoPeople } from './lib.mjs';

const { check, note, finish } = reporter('hardening');
const { workspaceId, alice } = await twoPeople('E2E hardening');

// ---- cross-site WebSocket hijacking --------------------------------------
// A browser sends cookies on a WebSocket to our origin no matter which site
// opened it, and same-origin policy does not apply. So the upgrade itself has
// to check where it came from.
const upgradeWith = (channel, origin) =>
  new Promise((resolve) => {
    const socket = new WebSocket(`${WS_ORIGIN}/${channel}`, origin ? { headers: { Origin: origin } } : {});
    const done = (result) => { try { socket.close(); } catch { /* already closed */ } resolve(result); };
    socket.on('unexpected-response', (_req, res) => done(`rejected ${res.statusCode}`));
    socket.on('open', () => done('accepted'));
    socket.on('error', () => done('rejected'));
    setTimeout(() => done('timeout'), 8000);
  });

for (const channel of ['sync', 'events', 'terminal', 'chat']) {
  const result = await upgradeWith(channel, 'https://evil.example.com');
  check(`/${channel} refuses an upgrade from another site`, result.startsWith('rejected'), result);
}
check('/events still accepts the app’s own origin',
  (await upgradeWith('events', 'http://localhost:5173')) === 'accepted');
check('/events still accepts a non-browser client (no Origin)',
  (await upgradeWith('events', undefined)) === 'accepted');

// ---- the cookie must not be usable as a WebSocket credential ------------
const joined = await fetch(`${API}/api/invites/${alice.workspace.inviteToken}/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: 'CookieHolder', asNewUser: true }),
});
const cookie = joined.headers.get('set-cookie')?.split(';')[0];
check('joining sets a session cookie', Boolean(cookie));

// A browser attaches the cookie itself; here we attach it by hand and send
// no token. The server must hand back nothing at all — before this fix it
// would have authenticated from the cookie and started syncing the document.
const cookieOnly = await new Promise((resolve) => {
  const socket = new WebSocket(`${WS_ORIGIN}/sync`, {
    headers: { Cookie: cookie ?? '', Origin: 'http://localhost:5173' },
  });
  let received = 0;
  socket.on('message', () => { received += 1; });
  socket.on('error', () => resolve({ opened: false, received }));
  setTimeout(() => {
    const opened = socket.readyState === WebSocket.OPEN;
    try { socket.close(); } catch { /* already closed */ }
    resolve({ opened, received });
  }, 3000);
});
check('a cookie alone gets no document data from /sync', cookieOnly.received === 0,
  `${cookieOnly.received} frames received, socket ${cookieOnly.opened ? 'open' : 'closed'}`);

// And the same connection with a proper token does work, so the check above
// is not passing merely because /sync is broken.
const withToken = await new Promise((resolve) => {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${WS_ORIGIN}/sync`, name: `${workspaceId}/README.md`,
    token: alice.token, document: doc, broadcast: false, preserveConnection: false, quiet: true,
  });
  setTimeout(() => {
    const text = doc.getText('content').toString();
    provider.destroy();
    resolve(text);
  }, 2500);
});
check('the same document does load with a real token', withToken.includes('Shared workspace'),
  `${withToken.length} chars`);

// ---- rate limiting --------------------------------------------------------
// The server under test is started with small limits; see the runner note.
let limited = null;
for (let i = 0; i < 12; i++) {
  const result = await call('POST', `/api/workspaces/${workspaceId}/ai`, { content: `probe ${i}` }, alice.token);
  if (result.status === 429) { limited = result; break; }
}
if (limited) {
  check('model requests are rate limited', limited.status === 429);
  check('and say when to come back', Boolean(limited.body?.error), limited.body?.error);
} else {
  note('rate limit not reached — run this suite with LIMIT_AI_REQUESTS small');
  check('model requests are rate limited', false, 'no 429 within 12 requests');
}

// ---- response headers -----------------------------------------------------
const headers = (await fetch(`${API}/api/health`)).headers;
check('responses forbid MIME sniffing', headers.get('x-content-type-options') === 'nosniff');
check('responses forbid framing', headers.get('x-frame-options') === 'DENY');
check('responses send no referrer', headers.get('referrer-policy') === 'no-referrer');

// ---- the sandbox is not root ---------------------------------------------
const shell = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${WS_ORIGIN}/terminal`);
  const term = { socket, text: '' };
  socket.on('open', () => socket.send(JSON.stringify({ type: 'start', token: alice.token, workspaceId, cols: 80, rows: 24 })));
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'output') term.text += m.data;
    if (m.type === 'ready') resolve(term);
    if (m.type === 'error') reject(new Error(m.message));
  });
  setTimeout(() => reject(new Error('shell never started')), 180000);
});
const run = async (command) => {
  shell.text = '';
  shell.socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
  await sleep(2500);
  return shell.text;
};

check('the shell does not run as root', /uid=(?!0\b)\d+/.test(await run('id')), (await run('id')).split('\n')[1]?.slice(0, 40));
check('the shell cannot write outside the workspace', /denied|read-only/i.test(await run('echo x > /etc/probe 2>&1')));
check('the shell cannot install packages', /denied|error/i.test(await run('apk add curl 2>&1 | tail -1')));
check('the shell can still work in /workspace', /ok/.test(await run('echo ok > /workspace/probe.txt && cat /workspace/probe.txt')));
shell.socket.close();

await sleep(300);
finish();
