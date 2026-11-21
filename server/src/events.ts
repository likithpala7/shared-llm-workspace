import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AiMessageDto } from './aiThread.js';
import type { ToolCallDto } from './approvals.js';
import { queries } from './db.js';
import { verifyToken } from './auth.js';

/**
 * The workspace events channel. Milestone 1 uses it to keep the file tree and
 * member list fresh; team chat and the AI thread share it from milestone 2 on.
 */
export type PresenceEntry = { userId: string; displayName: string; tabs: number };

export type WorkspaceEvent =
  | { type: 'files_changed' }
  /** Who currently has this workspace open. */
  | { type: 'presence'; online: PresenceEntry[] }
  | { type: 'members_changed' }
  /** A thread message was created or changed status. */
  | { type: 'ai_message'; message: AiMessageDto }
  | { type: 'ai_message_updated'; message: AiMessageDto }
  /** A chunk of the answer being streamed right now. */
  | { type: 'ai_delta'; id: string; text: string }
  /** A command the agent wants to run, and what happens to it. */
  | { type: 'tool_call'; call: ToolCallDto }
  | { type: 'tool_call_updated'; call: ToolCallDto }
  | { type: 'tool_call_output'; id: string; text: string };

type Client = { socket: WebSocket; workspaceId: string; userId: string };

const clients = new Set<Client>();

export const eventsWss = new WebSocketServer({ noServer: true });

eventsWss.on('connection', (socket: WebSocket, _request: IncomingMessage) => {
  let client: Client | null = null;

  // The first frame authenticates. The token travels in the message body rather
  // than the URL so it stays out of logs and history.
  socket.on('message', (raw) => {
    if (client) return;
    let message: { type?: string; token?: string; workspaceId?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      socket.close(1008, 'bad message');
      return;
    }
    if (message.type !== 'subscribe') return;

    const userId = verifyToken(message.token);
    const workspaceId = message.workspaceId;
    if (!userId || !workspaceId || !queries.getMembership.get(userId, workspaceId)) {
      socket.close(1008, 'not a member');
      return;
    }

    client = { socket, workspaceId, userId };
    clients.add(client);
    socket.send(JSON.stringify({ type: 'subscribed' }));
    // Presence rides on this channel because every open tab holds one, whether
    // or not the chat panel is showing.
    broadcastPresence(workspaceId);
  });

  socket.on('close', () => {
    if (!client) return;
    const { workspaceId } = client;
    clients.delete(client);
    client = null;
    broadcastPresence(workspaceId);
  });
});

/** One entry per person, however many tabs they have open. */
export function onlineIn(workspaceId: string): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>();
  for (const client of clients) {
    if (client.workspaceId !== workspaceId) continue;
    const existing = byUser.get(client.userId);
    if (existing) {
      existing.tabs += 1;
      continue;
    }
    const user = queries.getUser.get(client.userId);
    byUser.set(client.userId, {
      userId: client.userId,
      displayName: user?.display_name ?? 'Someone',
      tabs: 1,
    });
  }
  return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function broadcastPresence(workspaceId: string): void {
  broadcast(workspaceId, { type: 'presence', online: onlineIn(workspaceId) });
}

export function broadcast(workspaceId: string, event: WorkspaceEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.workspaceId !== workspaceId) continue;
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
  }
}
