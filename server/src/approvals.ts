import crypto from 'node:crypto';
import { can } from './auth.js';
import { exec } from './container.js';
import { queries, type ToolCall, type User } from './db.js';
import { broadcast } from './events.js';

/**
 * `run_command` is the one tool that needs a human. The agent asks, everyone
 * sees a card, and the first member to click decides it. The turn — and so the
 * whole queue — waits here, which is why the wait has a timeout.
 */
/** Five minutes by default; shortened in tests via APPROVAL_TIMEOUT_MS. */
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60 * 1000);
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

export type ToolCallDto = {
  id: string;
  aiMessageId: string;
  command: string;
  status: ToolCall['status'];
  decidedBy: string | null;
  decidedByName: string | null;
  output: string;
  createdAt: string;
};

export function toToolCallDto(call: ToolCall): ToolCallDto {
  const decider = call.decided_by ? queries.getUser.get(call.decided_by) : null;
  return {
    id: call.id,
    aiMessageId: call.ai_message_id,
    command: call.command,
    status: call.status,
    decidedBy: call.decided_by,
    decidedByName: decider?.display_name ?? null,
    output: call.output,
    createdAt: call.created_at,
  };
}

export function listToolCalls(workspaceId: string): ToolCallDto[] {
  return queries.listToolCallsForWorkspace.all(workspaceId).map(toToolCallDto);
}

/** Cards waiting on a human, by tool call id. */
type Waiting = { workspaceId: string; resolve: (decision: 'approved' | 'denied' | 'timed_out') => void };
const waiting = new Map<string, Waiting>();

function announce(callId: string, workspaceId: string): void {
  const call = queries.getToolCall.get(callId);
  if (call) broadcast(workspaceId, { type: 'tool_call_updated', call: toToolCallDto(call) });
}

/**
 * Records a decision. Returns false when the card was already decided — which
 * is how the second clicker finds out they were not first.
 */
export function decide(
  callId: string,
  user: User,
  workspaceId: string,
  decision: 'approved' | 'denied',
): boolean {
  if (!can(user, 'approve_command', workspaceId)) return false;

  const result = queries.decideToolCall.run(decision, user.id, callId);
  if (result.changes === 0) return false;

  announce(callId, workspaceId);
  waiting.get(callId)?.resolve(decision);
  return true;
}

/**
 * Creates the card, waits for a member to answer it, runs the command if they
 * approved, and returns what the model should be told either way.
 */
export async function requestAndRun(
  workspaceId: string,
  aiMessageId: string,
  command: string,
  signal: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  const callId = crypto.randomBytes(8).toString('hex');
  queries.insertToolCall.run(callId, aiMessageId, command, new Date().toISOString());

  const created = queries.getToolCall.get(callId)!;
  broadcast(workspaceId, { type: 'tool_call', call: toToolCallDto(created) });

  const decision = await new Promise<'approved' | 'denied' | 'timed_out' | 'stopped'>((resolve) => {
    const settle = (value: 'approved' | 'denied' | 'timed_out' | 'stopped') => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      waiting.delete(callId);
      resolve(value);
    };

    const timer = setTimeout(() => {
      queries.expireToolCall.run(callId);
      announce(callId, workspaceId);
      settle('timed_out');
    }, APPROVAL_TIMEOUT_MS);

    const onAbort = () => {
      queries.expireToolCall.run(callId);
      announce(callId, workspaceId);
      settle('stopped');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    waiting.set(callId, { workspaceId, resolve: settle });
  });

  if (decision === 'denied') {
    return { output: 'A member denied this command. It was not run.', isError: true };
  }
  if (decision === 'timed_out') {
    return {
      output: 'Nobody answered the approval request within five minutes. The command was not run.',
      isError: true,
    };
  }
  if (decision === 'stopped') {
    return { output: 'The turn was stopped before anyone answered. The command was not run.', isError: true };
  }

  // Approved: run it in the agent's own shell, not in anyone's terminal.
  let streamed = '';
  const result = await exec(workspaceId, command, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    onOutput: (chunk) => {
      streamed += chunk;
      queries.appendToolCallOutput.run(chunk, callId);
      broadcast(workspaceId, { type: 'tool_call_output', id: callId, text: chunk });
    },
  });

  announce(callId, workspaceId);

  const trimmed = streamed.length > 8000 ? `${streamed.slice(0, 8000)}\n…(truncated)` : streamed;
  if (result.timedOut) {
    return { output: `The command hit the two-minute limit and was stopped.\n\n${trimmed}`, isError: true };
  }
  return {
    output: `exit code ${result.exitCode ?? 'unknown'}\n\n${trimmed || '(no output)'}`,
    isError: result.exitCode !== 0,
  };
}

/** Nobody can answer a card that was pending when the server stopped. */
export function expirePendingOnStartup(): void {
  queries.expireAllPendingToolCalls.run();
}
