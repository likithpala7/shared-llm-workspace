import { useState } from 'react';
import type { ToolCall } from '../lib/api';

/**
 * The agent wants to run a command. Everyone sees this; whoever clicks first
 * decides it. The turn, and the queue behind it, waits until then.
 */
export function ApprovalCard({
  call,
  onDecide,
}: {
  call: ToolCall;
  onDecide: (callId: string, decision: 'approve' | 'deny') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'deny') {
    setBusy(true);
    setError(null);
    try {
      await onDecide(call.id, decision);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label =
    call.status === 'pending'
      ? 'waiting for anyone to approve'
      : call.status === 'approved'
        ? `approved by ${call.decidedByName ?? 'a member'}`
        : call.status === 'denied'
          ? `denied by ${call.decidedByName ?? 'a member'}`
          : 'timed out — nobody answered in five minutes';

  return (
    <article className={`approval approval-${call.status}`}>
      <header className="approval-head">
        <span className="approval-title">The agent wants to run a command</span>
        <span className="approval-status">{label}</span>
      </header>

      <pre className="approval-command">{call.command}</pre>

      {call.status === 'pending' && (
        <div className="approval-actions">
          <button type="button" disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </button>
          <button type="button" className="deny" disabled={busy} onClick={() => void decide('deny')}>
            Deny
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {call.output && <pre className="approval-output">{call.output}</pre>}
    </article>
  );
}
