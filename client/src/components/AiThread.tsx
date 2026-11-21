import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AiMessage, ToolCall } from '../lib/api';
import { ApprovalCard } from './ApprovalCard';

type Props = {
  workspaceId: string;
  messages: AiMessage[];
  toolCalls: ToolCall[];
  onDecide: (callId: string, decision: 'approve' | 'deny') => Promise<void>;
  currentUserId: string;
  busy: boolean;
  onSend: (content: string) => Promise<void>;
  onCancel: (messageId: string) => Promise<void>;
  onStop: () => Promise<void>;
};

function statusLabel(message: AiMessage): string | null {
  if (message.status === 'queued') return 'waiting';
  if (message.status === 'running') return message.kind === 'request' ? 'running' : null;
  if (message.status === 'cancelled') return message.kind === 'request' ? 'cancelled' : 'stopped';
  return null;
}

export function AiThread({
  workspaceId,
  messages,
  toolCalls,
  currentUserId,
  busy,
  onSend,
  onCancel,
  onStop,
  onDecide,
}: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [memory, setMemory] = useState<
    { summary: string | null; verbatimMessages: number; verbatimTokens: number } | null
  >(null);
  const [showMemory, setShowMemory] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Follow the stream as it arrives.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const queued = messages.filter((m) => m.kind === 'request' && m.status === 'queued');

  // Debug view of what the model is carrying, refreshed when opened and when
  // the thread moves on.
  useEffect(() => {
    if (!showMemory) return;
    let cancelled = false;
    api
      .getSummary(workspaceId)
      .then((result) => !cancelled && setMemory(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showMemory, workspaceId, messages.length]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="thread">
      <header className="pane-head">
        <span className="pane-meta">
          {queued.length > 0
            ? `${queued.length} request${queued.length === 1 ? '' : 's'} waiting`
            : busy
              ? 'running a turn'
              : 'one request at a time, in arrival order'}
        </span>
        <div className="thread-head-actions">
          <button type="button" className="link" onClick={() => setShowMemory((v) => !v)}>
            {showMemory ? 'hide memory' : 'memory'}
          </button>
          {busy && (
            <button type="button" className="stop" onClick={() => void onStop()}>
              Stop
            </button>
          )}
        </div>
      </header>

      {showMemory && (
        <div className="memory">
          <div className="memory-stats">
            {memory
              ? `${memory.verbatimMessages} messages verbatim (~${memory.verbatimTokens} tokens)`
              : 'loading…'}
          </div>
          <div className="memory-summary">
            {memory?.summary ?? 'Nothing summarised yet — the whole thread still fits.'}
          </div>
        </div>
      )}

      <div className="thread-messages">
        {messages.length === 0 && (
          <p className="muted empty">
            Nothing yet. Every message here is a request to the agent — use team chat for
            discussion.
          </p>
        )}

        {messages.map((message) => {
          // A command needing approval gets a card; other tools get one line.
          const card = toolCalls.find((c) => c.aiMessageId === message.id);
          if (card) {
            return <ApprovalCard key={message.id} call={card} onDecide={onDecide} />;
          }

          if (message.kind === 'tool_call' || message.kind === 'tool_result') {
            if (message.content.startsWith('exit code') || message.content.startsWith('run_command')) {
              return null; // The card already shows this.
            }
            return (
              <div key={message.id} className={`tool tool-${message.kind}`}>
                <span className="tool-mark">{message.kind === 'tool_call' ? '→' : '←'}</span>
                <span className="tool-text">{message.content}</span>
              </div>
            );
          }

          const label = statusLabel(message);
          const mine = message.authorId === currentUserId;
          return (
            <article key={message.id} className={`msg msg-${message.kind} status-${message.status}`}>
              <div className="msg-head">
                <span className="msg-author">
                  {message.kind === 'request' ? message.authorName ?? 'Someone' : 'Agent'}
                </span>
                {label && <span className="msg-status">{label}</span>}
                {mine && message.status === 'queued' && (
                  <button type="button" className="link" onClick={() => void onCancel(message.id)}>
                    cancel
                  </button>
                )}
              </div>
              <div className="msg-body">
                {message.content ||
                  (message.kind === 'assistant' && message.status === 'running' ? (
                    <span className="muted">thinking…</span>
                  ) : (
                    ''
                  ))}
              </div>
            </article>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="thread-form" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit(e);
            }
          }}
          rows={3}
          placeholder="Ask the agent for a change… (every message here is a request)"
        />
        <button type="submit" disabled={sending || draft.trim().length === 0}>
          {busy ? 'Queue request' : 'Send request'}
        </button>
      </form>
    </section>
  );
}
