export type TeamMessage = {
  id: string;
  userId: string;
  displayName: string;
  content: string;
  createdAt: string;
};

type Incoming =
  | { type: 'history'; messages: TeamMessage[] }
  | { type: 'message'; message: TeamMessage };

/**
 * Team chat has its own socket, separate from the workspace events channel —
 * the same separation the server keeps, so nothing the agent touches can reach
 * these messages.
 */
export function connectChat(
  workspaceId: string,
  token: string,
  onEvent: (event: Incoming) => void,
): { send: (content: string) => void; close: () => void } {
  let socket: WebSocket | null = null;
  let retry: number | undefined;
  let closed = false;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/chat`);

    socket.onopen = () => socket?.send(JSON.stringify({ type: 'subscribe', token, workspaceId }));
    socket.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data) as Incoming);
      } catch {
        // Ignore anything we cannot parse.
      }
    };
    socket.onclose = () => {
      if (!closed) retry = window.setTimeout(connect, 1000);
    };
  };

  connect();

  return {
    send: (content: string) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'say', content }));
      }
    },
    close: () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    },
  };
}
