import { useEffect, useRef, useState } from 'react';
import type { TeamMessage } from '../lib/chat';

/**
 * People talking to people, beside the AI thread. Nothing written here reaches
 * the model.
 */
export function TeamChat({
  messages,
  currentUserId,
  online,
  onSend,
}: {
  messages: TeamMessage[];
  currentUserId: string;
  online: Array<{ userId: string; displayName: string }>;
  onSend: (content: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Only follow new messages if you are already at the bottom.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom < 120) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft('');
  }

  return (
    <section className="chat">
      <header className="pane-head">
        <span className="pane-meta">
          {online.length > 0
            ? `${online.map((p) => p.displayName).join(', ')} online`
            : 'nobody else here'}
        </span>
        <span className="pane-meta">the agent never sees this</span>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="muted empty">Talk to the team here. The agent never sees this.</p>
        )}
        {messages.map((message) => (
          <div key={message.id} className="chat-msg">
            <span className={`chat-author${message.userId === currentUserId ? ' mine' : ''}`}>
              {message.displayName}
            </span>
            <span className="chat-text">{message.content}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="chat-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the team…"
        />
      </form>
    </section>
  );
}
