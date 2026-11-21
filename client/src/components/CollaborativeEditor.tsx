import { useEffect, useRef, useState } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { languageForPath, monaco } from '../lib/monaco';
import type { Identity } from '../lib/identity';
import { colorFor } from '../lib/identity';

type Props = { workspaceId: string; filePath: string; identity: Identity };

const Y_TEXT_KEY = 'content';

function syncUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/sync`;
}

/**
 * y-monaco draws remote selections as decorations classed by client id but ships
 * no CSS, so each peer's colour and name label are injected here.
 */
function renderCursorStyles(styleElement: HTMLStyleElement, awareness: any, localClientId: number) {
  const rules: string[] = [];
  awareness.getStates().forEach((state: any, clientId: number) => {
    if (clientId === localClientId || !state?.user) return;
    const color = state.user.color ?? '#f59e0b';
    const name = String(state.user.name ?? 'Someone').replace(/["\\]/g, '');
    rules.push(`
      .yRemoteSelection-${clientId} { background-color: ${color}; opacity: 0.3; }
      .yRemoteSelectionHead-${clientId} {
        position: absolute;
        border-left: ${color} solid 2px;
        height: 100%;
        box-sizing: border-box;
      }
      .yRemoteSelectionHead-${clientId}::after {
        content: "${name}";
        position: absolute;
        top: -1.35em;
        left: -2px;
        padding: 0 4px;
        font-size: 11px;
        line-height: 1.3;
        white-space: nowrap;
        border-radius: 3px 3px 3px 0;
        background-color: ${color};
        color: #fff;
      }
    `);
  });
  styleElement.textContent = rules.join('\n');
}

export function CollaborativeEditor({ workspaceId, filePath, identity }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setStatus('connecting');
    setError(null);

    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: syncUrl(),
      name: `${workspaceId}/${filePath}`,
      token: identity.token,
      document: ydoc,
      // Everything goes through the server, so two tabs prove real sync.
      broadcast: false,
      // Close the socket on destroy instead of leaving it open for the next
      // document; otherwise switching files leaks an unauthenticated connection.
      preserveConnection: false,
      onStatus: ({ status: next }) => setStatus(String(next)),
      onSynced: () => setStatus('synced'),
      onAuthenticationFailed: ({ reason }) => setError(reason ?? 'not allowed'),
    });

    const model = monaco.editor.createModel('', languageForPath(filePath));
    const editor = monaco.editor.create(container, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      // Room above the first line so a peer's name label is never clipped.
      padding: { top: 22 },
      tabSize: 2,
    });

    provider.awareness?.setLocalStateField('user', {
      name: identity.displayName,
      color: colorFor(identity.userId),
    });

    const binding = new MonacoBinding(
      ydoc.getText(Y_TEXT_KEY),
      model,
      new Set([editor]),
      provider.awareness ?? undefined,
    );

    const styleElement = document.createElement('style');
    document.head.appendChild(styleElement);
    const awareness = provider.awareness;
    const onAwarenessChange = () => {
      if (awareness) renderCursorStyles(styleElement, awareness, ydoc.clientID);
    };
    awareness?.on('change', onAwarenessChange);
    onAwarenessChange();

    return () => {
      awareness?.off('change', onAwarenessChange);
      styleElement.remove();
      binding.destroy();
      editor.dispose();
      model.dispose();
      provider.destroy();
      ydoc.destroy();
    };
  }, [workspaceId, filePath, identity.token, identity.displayName, identity.userId]);

  return (
    <div className="editor-wrap">
      <div className="editor-bar">
        <span className="file-path">{filePath}</span>
        <span className={`status status-${status}`}>{error ? `error: ${error}` : status}</span>
      </div>
      <div className="editor-host" ref={containerRef} />
    </div>
  );
}
