// Fan-out: many tabs watching one workspace.
//
//   TABS=60 node tests/load/sockets.mjs
import WebSocket from 'ws';
import { WS_ORIGIN, call, reporter, sleep, twoPeople } from '../e2e/lib.mjs';

const TABS = Number(process.env.TABS ?? 40);

const { check, note, finish } = reporter('load:sockets');
const { workspaceId, alice, bob } = await twoPeople('Load sockets');

note(`${TABS} event tabs plus ${TABS} chat tabs`);

const openSocket = (channel, token, payload) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_ORIGIN}/${channel}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`${channel} never settled`)), 30000);
    socket.on('open', () => socket.send(JSON.stringify(payload)));
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      messages.push({ ...m, at: Date.now() });
      if (m.type === 'subscribed' || m.type === 'history') {
        clearTimeout(timer);
        resolve({ socket, messages });
      }
    });
    socket.on('error', reject);
  });

const connectStarted = Date.now();
const eventTabs = await Promise.all(
  Array.from({ length: TABS }, (_, i) =>
    openSocket('events', i % 2 === 0 ? alice.token : bob.token,
      { type: 'subscribe', token: i % 2 === 0 ? alice.token : bob.token, workspaceId })),
);
const chatTabs = await Promise.all(
  Array.from({ length: TABS }, (_, i) =>
    openSocket('chat', i % 2 === 0 ? alice.token : bob.token,
      { type: 'subscribe', token: i % 2 === 0 ? alice.token : bob.token, workspaceId })),
);
check('every tab connected', eventTabs.length === TABS && chatTabs.length === TABS,
  `${TABS * 2} sockets in ${Date.now() - connectStarted}ms`);

await sleep(1500);
const presence = eventTabs[0].messages.filter((m) => m.type === 'presence').at(-1);
check('presence counts people, not tabs', presence.online.length === 2,
  presence.online.map((p) => `${p.displayName}×${p.tabs}`).join(', '));
check('tab counts add up', presence.online.reduce((sum, p) => sum + p.tabs, 0) === TABS,
  `${presence.online.reduce((sum, p) => sum + p.tabs, 0)} of ${TABS}`);

// One chat message must reach every chat tab, and no event tab.
const sentAt = Date.now();
chatTabs[0].socket.send(JSON.stringify({ type: 'say', content: 'fan-out probe' }));
await sleep(2000);

const delivered = chatTabs.filter((t) => t.messages.some((m) => m.type === 'message' && m.message.content === 'fan-out probe'));
check('the message reached every chat tab', delivered.length === TABS, `${delivered.length}/${TABS}`);
check('and no event tab', eventTabs.every((t) => !t.messages.some((m) => JSON.stringify(m).includes('fan-out probe'))));

const arrivals = delivered
  .map((t) => t.messages.find((m) => m.type === 'message' && m.message.content === 'fan-out probe').at - sentAt)
  .sort((a, b) => a - b);
note(`fan-out p50 ${arrivals[Math.floor(arrivals.length / 2)]}ms · slowest ${arrivals.at(-1)}ms`);
check('the slowest tab is still prompt', arrivals.at(-1) < 2000, `${arrivals.at(-1)}ms`);

// Closing half of them must leave presence correct.
for (const tab of eventTabs.slice(0, TABS / 2)) tab.socket.close();
await sleep(1500);
const after = eventTabs.at(-1).messages.filter((m) => m.type === 'presence').at(-1);
check('presence drops the closed tabs',
  after.online.reduce((sum, p) => sum + p.tabs, 0) === TABS / 2,
  `${after.online.reduce((sum, p) => sum + p.tabs, 0)} tabs left`);

const healthy = await call('GET', `/api/workspaces/${workspaceId}/files`, null, alice.token);
check('the server is unharmed', healthy.status === 200);

for (const tab of [...eventTabs.slice(TABS / 2), ...chatTabs]) tab.socket.close();
await sleep(400);
finish();
