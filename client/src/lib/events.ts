import type { AiMessage, ToolCall } from './api';

export type PresenceEntry = { userId: string; displayName: string; tabs: number };

export type WorkspaceEvent =
  | { type: 'files_changed' }
  | { type: 'presence'; online: PresenceEntry[] }
  | { type: 'members_changed' }
  | { type: 'ai_message'; message: AiMessage }
  | { type: 'ai_message_updated'; message: AiMessage }
  | { type: 'ai_delta'; id: string; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_updated'; call: ToolCall }
  | { type: 'tool_call_output'; id: string; text: string };

/**
 * Subscribes to the workspace events channel, reconnecting if the server
 * restarts. Returns a function that closes the connection for good.
 */
export function subscribeToWorkspace(
  workspaceId: string,
  token: string,
  onEvent: (event: WorkspaceEvent) => void,
): () => void {
  let socket: WebSocket | null = null;
  let retry: number | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/events`);

    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: 'subscribe', token, workspaceId }));
    };

    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as WorkspaceEvent | { type: 'subscribed' };
        if (event.type !== 'subscribed') onEvent(event);
      } catch {
        // Ignore anything we cannot parse.
      }
    };

    socket.onclose = () => {
      if (closed) return;
      retry = window.setTimeout(connect, 1000);
    };
  };

  connect();

  return () => {
    closed = true;
    window.clearTimeout(retry);
    socket?.close();
  };
}
