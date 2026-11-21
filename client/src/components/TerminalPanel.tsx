import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Identity } from '../lib/identity';

/**
 * One shell per person, running inside the workspace's container. Everyone's
 * terminal shares the same /workspace folder, so what one person creates the
 * others see in their file tree.
 */
export function TerminalPanel({
  workspaceId,
  identity,
  onClose,
}: {
  workspaceId: string;
  identity: Identity;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('connecting…');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#11131a', foreground: '#e6e8ec' },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/terminal`);

    const send = (message: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.onopen = () => {
      send({
        type: 'start',
        token: identity.token,
        workspaceId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'output') terminal.write(message.data);
      if (message.type === 'status') setStatus(message.message);
      if (message.type === 'ready') {
        setStatus('connected');
        terminal.focus();
      }
      if (message.type === 'error') {
        setStatus(message.message);
        terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
      }
      if (message.type === 'exit') setStatus('shell exited');
    };

    socket.onclose = () => setStatus((current) => (current === 'connected' ? 'disconnected' : current));

    const onData = terminal.onData((data) => send({ type: 'input', data }));

    const resize = () => {
      fit.fit();
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      onData.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [workspaceId, identity.token]);

  return (
    <section className="terminal">
      <header className="terminal-head">
        <span>Terminal — {identity.displayName}</span>
        <span className="muted">{status}</span>
        <button type="button" className="link" onClick={onClose}>
          hide
        </button>
      </header>
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}
