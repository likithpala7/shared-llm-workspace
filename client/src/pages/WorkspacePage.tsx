import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AiMessage, type Member, type ToolCall, type TreeNode } from '../lib/api';
import { AiThread } from '../components/AiThread';
import { TerminalPanel } from '../components/TerminalPanel';
import { CollaborativeEditor } from '../components/CollaborativeEditor';
import { FileTree } from '../components/FileTree';
import { subscribeToWorkspace, type PresenceEntry } from '../lib/events';
import { connectChat, type TeamMessage } from '../lib/chat';
import { TeamChat } from '../components/TeamChat';
import { clearIdentity, loadIdentity, saveIdentity, type Identity } from '../lib/identity';

const lastFileKey = (workspaceId: string) => `slw_last_file:${workspaceId}`;
const paneKey = 'slw_right_pane';

type RightPane = 'thread' | 'chat';

function firstEditableFile(nodes: TreeNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'file' && node.editable) return node.path;
    if (node.type === 'dir') {
      const found = firstEditableFile(node.children);
      if (found) return found;
    }
  }
  return null;
}

export function WorkspacePage({ workspaceId, navigate }: { workspaceId: string; navigate: (path: string) => void }) {
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity());
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [thread, setThread] = useState<AiMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chat, setChat] = useState<TeamMessage[]>([]);
  const [online, setOnline] = useState<PresenceEntry[]>([]);
  const [pane, setPane] = useState<RightPane>(
    () => (localStorage.getItem(paneKey) as RightPane | null) ?? 'thread',
  );
  // What each pane had when you last looked at it, so the hidden one can show
  // that something arrived.
  const [seen, setSeen] = useState({ thread: 0, chat: 0 });
  const chatRef = useRef<{ send: (content: string) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A tab with no identity of its own falls back to the session cookie.
  useEffect(() => {
    if (identity) return;
    api
      .me()
      .then((me) => {
        const next = { token: me.token, userId: me.id, displayName: me.displayName };
        saveIdentity(next);
        setIdentity(next);
      })
      .catch(() => navigate('/'));
  }, [identity, navigate]);

  const refreshFiles = useCallback(async () => {
    const result = await api.getFiles(workspaceId);
    setTree(result.tree);
    return result.tree;
  }, [workspaceId]);

  const refreshMembers = useCallback(async () => {
    const info = await api.getWorkspace(workspaceId);
    setMembers(info.members);
  }, [workspaceId]);

  // Files created by anyone — a teammate now, the agent and terminals later —
  // show up without a reload.
  useEffect(() => {
    if (!identity) return;
    return subscribeToWorkspace(workspaceId, identity.token, (event) => {
      if (event.type === 'files_changed') void refreshFiles();
      if (event.type === 'members_changed') void refreshMembers();
      if (event.type === 'presence') setOnline(event.online);
      if (event.type === 'ai_message') {
        setThread((current) =>
          current.some((m) => m.id === event.message.id) ? current : [...current, event.message],
        );
      }
      if (event.type === 'ai_message_updated') {
        setThread((current) =>
          current.map((m) =>
            m.id === event.message.id
              ? // Keep streamed text: the row in the database is only written
                // once the turn ends.
                { ...event.message, content: event.message.content || m.content }
              : m,
          ),
        );
      }
      if (event.type === 'tool_call') {
        setToolCalls((current) =>
          current.some((c) => c.id === event.call.id) ? current : [...current, event.call],
        );
      }
      if (event.type === 'tool_call_updated') {
        setToolCalls((current) =>
          current.map((c) =>
            c.id === event.call.id ? { ...event.call, output: event.call.output || c.output } : c,
          ),
        );
      }
      if (event.type === 'tool_call_output') {
        setToolCalls((current) =>
          current.map((c) => (c.id === event.id ? { ...c, output: c.output + event.text } : c)),
        );
      }
      if (event.type === 'ai_delta') {
        setThread((current) =>
          current.map((m) => (m.id === event.id ? { ...m, content: m.content + event.text } : m)),
        );
      }
    });
  }, [workspaceId, identity, refreshFiles, refreshMembers]);

  useEffect(() => {
    if (!identity) return;
    const connection = connectChat(workspaceId, identity.token, (event) => {
      if (event.type === 'history') setChat(event.messages);
      if (event.type === 'message') {
        setChat((current) =>
          current.some((m) => m.id === event.message.id) ? current : [...current, event.message],
        );
      }
    });
    chatRef.current = connection;
    return () => {
      chatRef.current = null;
      connection.close();
    };
  }, [workspaceId, identity]);

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await api.getWorkspace(workspaceId);
        if (cancelled) return;
        setWorkspaceName(info.workspace.name);
        setInviteToken(info.workspace.inviteToken);
        setMembers(info.members);

        const history = await api.getThread(workspaceId);
        if (cancelled) return;
        setThread(history.messages);
        setToolCalls(history.toolCalls);

        const nodes = await refreshFiles();
        if (cancelled) return;
        const remembered = localStorage.getItem(lastFileKey(workspaceId));
        const paths = new Set<string>();
        const collect = (list: TreeNode[]) => {
          for (const node of list) {
            if (node.type === 'file' && node.editable) paths.add(node.path);
            else if (node.type === 'dir') collect(node.children);
          }
        };
        collect(nodes);
        setActivePath(remembered && paths.has(remembered) ? remembered : firstEditableFile(nodes));
      } catch (caught) {
        if (!cancelled) setError((caught as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, identity, refreshFiles]);

  // Whichever pane is open is caught up by definition.
  useEffect(() => {
    setSeen((current) =>
      pane === 'thread'
        ? { ...current, thread: thread.length }
        : { ...current, chat: chat.length },
    );
  }, [pane, thread.length, chat.length]);

  function selectPane(next: RightPane) {
    setPane(next);
    localStorage.setItem(paneKey, next);
  }

  function openFile(filePath: string) {
    setActivePath(filePath);
    localStorage.setItem(lastFileKey(workspaceId), filePath);
  }

  async function addFile() {
    const filePath = window.prompt('New file path, relative to the workspace root');
    if (!filePath) return;
    try {
      await api.createFile(workspaceId, filePath);
      await refreshFiles();
      openFile(filePath);
    } catch (caught) {
      window.alert((caught as Error).message);
    }
  }

  const busy = thread.some((m) => m.status === 'running');

  async function sendRequest(content: string) {
    await api.sendRequest(workspaceId, content);
  }

  async function cancelRequest(messageId: string) {
    await api.cancelRequest(workspaceId, messageId);
  }

  async function stopTurn() {
    await api.stopTurn(workspaceId);
  }

  async function decideToolCall(callId: string, decision: 'approve' | 'deny') {
    await api.decideToolCall(workspaceId, callId, decision);
  }

  if (error) {
    return (
      <div className="centered">
        <div className="card">
          <h1>Cannot open this workspace</h1>
          <p className="error">{error}</p>
          <button type="button" onClick={() => { clearIdentity(); navigate('/'); }}>
            Start over
          </button>
        </div>
      </div>
    );
  }

  if (!identity) return <div className="centered muted">Signing in…</div>;

  const inviteUrl = inviteToken ? `${window.location.origin}/join/${inviteToken}` : '';

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h2>{workspaceName || 'Workspace'}</h2>
          <p className="muted">you are {identity.displayName}</p>
        </div>

        <div className="sidebar-section">
          <div className="section-title">
            <span>Files</span>
            <button type="button" className="link" onClick={addFile}>
              + new
            </button>
          </div>
          <FileTree nodes={tree} activePath={activePath} onOpen={openFile} />
        </div>

        <div className="sidebar-section">
          <div className="section-title">Members</div>
          <ul className="members">
            {members.map((member) => {
              const here = online.some((p) => p.userId === member.id);
              return (
                <li key={member.id} className={here ? 'member online' : 'member'}>
                  <span className="dot" aria-hidden="true" />
                  {member.displayName}
                  {member.id === identity.userId ? ' (you)' : ''}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="sidebar-section">
          <div className="section-title">Invite link</div>
          <input className="invite" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
          <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>
            copy
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="editor-area">
          {activePath && identity ? (
            <CollaborativeEditor
              key={`${workspaceId}/${activePath}/${identity.userId}`}
              workspaceId={workspaceId}
              filePath={activePath}
              identity={identity}
            />
          ) : (
            <div className="centered muted">Pick a file to start editing.</div>
          )}
        </div>

        {terminalOpen ? (
          <TerminalPanel
            workspaceId={workspaceId}
            identity={identity}
            onClose={() => setTerminalOpen(false)}
          />
        ) : (
          <button type="button" className="terminal-toggle" onClick={() => setTerminalOpen(true)}>
            Open my terminal
          </button>
        )}
      </main>

      <div className="right-column">
        <div className="pane-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={pane === 'thread'}
            className={pane === 'thread' ? 'pane-tab active' : 'pane-tab'}
            onClick={() => selectPane('thread')}
          >
            AI thread
            {pane !== 'thread' && thread.length > seen.thread && (
              <span className="pane-badge">{thread.length - seen.thread}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pane === 'chat'}
            className={pane === 'chat' ? 'pane-tab active' : 'pane-tab'}
            onClick={() => selectPane('chat')}
          >
            Team chat
            {pane !== 'chat' && chat.length > seen.chat && (
              <span className="pane-badge">{chat.length - seen.chat}</span>
            )}
          </button>
        </div>

        {pane === 'thread' ? (
          <AiThread
            workspaceId={workspaceId}
            messages={thread}
            toolCalls={toolCalls}
            onDecide={decideToolCall}
            currentUserId={identity.userId}
            busy={busy}
            onSend={sendRequest}
            onCancel={cancelRequest}
            onStop={stopTurn}
          />
        ) : (
          <TeamChat
            messages={chat}
            currentUserId={identity.userId}
            online={online.filter((p) => p.userId !== identity.userId)}
            onSend={(content) => chatRef.current?.send(content)}
          />
        )}
      </div>
    </div>
  );
}
