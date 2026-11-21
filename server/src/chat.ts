import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from './auth.js';
import { queries, type TeamMessage } from './db.js';

/**
 * Team chat, on its own WebSocket channel.
 *
 * This is where people talk to people. The model never sees any of it: no agent
 * module imports this file or the team_messages queries, and nothing here ever
 * reaches the AI thread.
 */
export const chatWss = new WebSocketServer({ noServer: true });

export type TeamMessageDto = {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  createdAt: string;
};

export function toTeamMessageDto(message: TeamMessage): TeamMessageDto {
  const author = queries.getUser.get(message.user_id);
  return {
    id: message.id,
    userId: message.user_id,
    displayName: author?.display_name ?? 'Someone',
    content: message.content,
    createdAt: message.created_at,
  };
}

export function listChat(workspaceId: string): TeamMessageDto[] {
  return queries.listTeamMessages.all(workspaceId).map(toTeamMessageDto);
}

type Client = { socket: WebSocket; workspaceId: string; userId: string };
const clients = new Set<Client>();

function broadcastToChat(workspaceId: string, payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const client of clients) {
    if (client.workspaceId !== workspaceId) continue;
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(text);
  }
}

chatWss.on('connection', (socket: WebSocket, _request: IncomingMessage) => {
  let client: Client | null = null;

  socket.on('message', (raw) => {
    let message: { type?: string; token?: string; workspaceId?: string; content?: string };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === 'subscribe') {
      if (client) return;
      const userId = verifyToken(message.token);
      const workspaceId = message.workspaceId;
      if (!userId || !workspaceId || !queries.getMembership.get(userId, workspaceId)) {
        socket.close(1008, 'not a member');
        return;
      }
      client = { socket, workspaceId, userId };
      clients.add(client);
      socket.send(JSON.stringify({ type: 'history', messages: listChat(workspaceId) }));
      return;
    }

    if (message.type === 'say' && client) {
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content) return;

      const id = crypto.randomBytes(8).toString('hex');
      queries.insertTeamMessage.run(
        id,
        client.workspaceId,
        client.userId,
        content.slice(0, 4000),
        new Date().toISOString(),
      );
      const stored = queries.getTeamMessage.get(id);
      if (stored) {
        broadcastToChat(client.workspaceId, { type: 'message', message: toTeamMessageDto(stored) });
      }
    }
  });

  socket.on('close', () => {
    if (client) clients.delete(client);
  });
});
