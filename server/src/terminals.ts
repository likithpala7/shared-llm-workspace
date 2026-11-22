import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from './auth.js';
import { openShell, shellClosed, shellOpened } from './container.js';
import { queries } from './db.js';
import { LIMITS, allow } from './rateLimit.js';
import { startWatching } from './watcher.js';

/**
 * One shell per connection, so every person gets their own terminal inside the
 * one container the workspace shares.
 */
export const terminalWss = new WebSocketServer({ noServer: true });

type Incoming =
  | { type: 'start'; token: string; workspaceId: string; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

terminalWss.on('connection', (socket: WebSocket, _request: IncomingMessage) => {
  let shell: Awaited<ReturnType<typeof openShell>> | null = null;
  let starting = false;
  let attachedTo: string | null = null;

  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on('message', async (raw) => {
    let message: Incoming;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === 'start') {
      if (shell || starting) return;
      starting = true;

      const userId = verifyToken(message.token);
      if (!userId || !queries.getMembership.get(userId, message.workspaceId)) {
        send({ type: 'error', message: 'not a member of this workspace' });
        socket.close(1008, 'not a member');
        return;
      }

      if (!allow(`terminal:${userId}`, LIMITS.terminal.max, LIMITS.terminal.windowMs)) {
        send({ type: 'error', message: 'too many shells started recently; wait a moment' });
        socket.close(1008, 'rate limited');
        return;
      }

      send({ type: 'status', message: 'starting container…' });
      try {
        shell = await openShell(message.workspaceId, {
          cols: message.cols || 80,
          rows: message.rows || 24,
        });
      } catch (error) {
        send({ type: 'error', message: `could not start a shell: ${(error as Error).message}` });
        socket.close(1011, 'shell failed');
        return;
      } finally {
        starting = false;
      }

      shellOpened(message.workspaceId);
      attachedTo = message.workspaceId;

      // A terminal is the main way files change behind Yjs's back.
      startWatching(message.workspaceId);

      shell.onData((data) => send({ type: 'output', data }));
      shell.onExit(({ exitCode }) => {
        send({ type: 'exit', exitCode });
        socket.close(1000, 'shell exited');
      });
      send({ type: 'ready' });
      return;
    }

    if (!shell) return;
    if (message.type === 'input') shell.write(message.data);
    if (message.type === 'resize') shell.resize(message.cols || 80, message.rows || 24);
  });

  socket.on('close', () => {
    shell?.kill();
    shell = null;
    if (attachedTo) {
      shellClosed(attachedTo);
      attachedTo = null;
    }
  });
});
