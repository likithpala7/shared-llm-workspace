// Milestone 6: people talk beside the AI thread, and the agent cannot see it.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { WS_ORIGIN, ask, call, reporter, sleep, twoPeople } from './lib.mjs';

const { check, finish } = reporter('chat');
const { workspaceId, alice, bob } = await twoPeople('E2E chat');

const openChat = (token, label) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${WS_ORIGIN}/chat`);
  const received = [];
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', token, workspaceId })));
  socket.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    received.push(m);
    if (m.type === 'history') resolve({ socket, received, label });
  });
  socket.on('error', reject);
  socket.on('close', (code) => reject(new Error(`${label}: closed ${code}`)));
});

const aliceChat = await openChat(alice.token, 'alice');
const bobChat = await openChat(bob.token, 'bob');
aliceChat.socket.send(JSON.stringify({ type: 'say', content: 'shall we rename the config file?' }));
await sleep(400);
bobChat.socket.send(JSON.stringify({ type: 'say', content: 'leave it, the deploy script needs that name' }));
await sleep(500);

const bobSaw = bobChat.received.filter((m) => m.type === 'message').map((m) => m.message.content);
check('a message reaches the other person live', bobSaw.includes('shall we rename the config file?'));
check('messages carry their sender',
  bobChat.received.find((m) => m.type === 'message').message.displayName === 'Alice');
const history = (await call('GET', `/api/workspaces/${workspaceId}/chat`, null, bob.token)).body;
check('chat is persisted', history.messages.length === 2, `${history.messages.length} messages`);
check('non-members cannot read chat',
  (await call('GET', `/api/workspaces/${workspaceId}/chat`, null, null)).status === 403);

const intruder = new WebSocket(`${WS_ORIGIN}/chat`);
const closeCode = await new Promise((resolve) => {
  intruder.on('open', () => intruder.send(JSON.stringify({ type: 'subscribe', token: 'nope', workspaceId })));
  intruder.on('close', (code) => resolve(code));
  setTimeout(() => resolve(0), 3000);
});
check('the chat channel rejects a bad token', closeCode === 1008, `close code ${closeCode}`);

const openEvents = (token) => new Promise((resolve) => {
  const socket = new WebSocket(`${WS_ORIGIN}/events`);
  const events = [];
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', token, workspaceId })));
  socket.on('message', (raw) => { const m = JSON.parse(String(raw)); events.push(m); if (m.type === 'subscribed') resolve({ socket, events }); });
});
const aliceTab = await openEvents(alice.token);
const bobTab = await openEvents(bob.token);
await sleep(600);
let presence = aliceTab.events.filter((e) => e.type === 'presence').at(-1);
check('presence lists who is online', presence.online.length === 2, presence.online.map((p) => p.displayName).join(', '));
bobTab.socket.close();
await sleep(700);
presence = aliceTab.events.filter((e) => e.type === 'presence').at(-1);
check('leaving removes you', presence.online.length === 1);
const secondTab = await openEvents(alice.token);
await sleep(600);
presence = aliceTab.events.filter((e) => e.type === 'presence').at(-1);
check('two tabs are one person', presence.online.length === 1 && presence.online[0].tabs === 2);

// The locked decision: the agent has no read path to team chat.
const offenders = [];
for (const file of ['aiThread.ts', 'agentTools.ts', 'llm.ts', 'approvals.ts', 'summaries.ts']) {
  const source = fs.readFileSync(path.join('server', 'src', file), 'utf8');
  for (const needle of ['team_messages', 'TeamMessage', 'chat.js', 'listChat', 'insertTeamMessage']) {
    if (source.includes(needle)) offenders.push(`${file}:${needle}`);
  }
}
check('no agent module mentions team chat', offenders.length === 0, offenders.join(', ') || 'clean');

const data = await ask(workspaceId, alice.token, 'Say OK.');
const leaked = data.messages.filter((m) => /rename the config file|deploy script needs/i.test(m.content));
check('nothing from chat appears in the AI thread', leaked.length === 0, `${leaked.length} leaks`);

aliceChat.socket.close(); bobChat.socket.close();
aliceTab.socket.close(); secondTab.socket.close(); intruder.close();
await sleep(300);
finish();
