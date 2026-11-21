import crypto from 'node:crypto';
import { AGENT_TOOLS, describeToolCall, runAgentTool } from './agentTools.js';
import { broadcast } from './events.js';
import { queries, type AiMessage } from './db.js';
import { llm } from './llm.js';
import { currentSummary, summariseIfNeeded, verbatimMessages } from './summaries.js';

/**
 * One FIFO queue and one worker per workspace. The worker takes the oldest
 * queued request, runs a full turn, then takes the next. Requests that arrive
 * during a turn wait in the queue, visible to everyone.
 */

export type AiMessageDto = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  kind: AiMessage['kind'];
  status: AiMessage['status'];
  content: string;
  createdAt: string;
};

/** The turn in flight, per workspace. */
type RunningTurn = { requestId: string; assistantId: string; abort: AbortController };
const running = new Map<string, RunningTurn>();

const newId = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

export function toDto(message: AiMessage): AiMessageDto {
  const author = message.author_id ? queries.getUser.get(message.author_id) : null;
  return {
    id: message.id,
    authorId: message.author_id,
    authorName: author?.display_name ?? null,
    kind: message.kind,
    status: message.status,
    content: message.content,
    createdAt: message.created_at,
  };
}

export function listThread(workspaceId: string): AiMessageDto[] {
  return queries.listAiMessages.all(workspaceId).map(toDto);
}

/** Tool output can be a whole file; the thread only needs a line. */
function summarise(name: string, output: string): string {
  if (name === 'read_file') {
    const lines = output.split('\n').length;
    return `read ${lines} line${lines === 1 ? '' : 's'}`;
  }
  const firstLine = output.split('\n')[0] ?? '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function announce(id: string, event: 'ai_message' | 'ai_message_updated'): void {
  const message = queries.getAiMessage.get(id);
  if (message) broadcast(message.workspace_id, { type: event, message: toDto(message) });
}

const SYSTEM_PROMPT = `You are the agent inside a shared coding workspace.

Several people share this one conversation. Every request is prefixed with the
sender's name in square brackets, like "[Alice]: add a README". Address people
by name, and keep in mind that the person asking now may not be the person who
asked last. When two requests conflict, say so rather than guessing.

You can list, read, create and edit files in the workspace, and you can ask to
run shell commands with run_command. A member has to approve each command before
it runs, and they may deny it; if that happens, say so and carry on with what you
can do without it.

Read a file before you edit it: people are typing in these same files while you
work, so the text you remember may already be stale. edit_file replaces one
exact string, so include enough surrounding text to be sure it appears only
once — if it fails, read the file again and retry.

Keep edits small and targeted rather than rewriting whole files, and say what
you changed when you are done.

In earlier turns, your own tool use appears in condensed form, as lines like
"(used edit_file notes.md)" and "(tool result: Edited notes.md.)". Those are
things you really did; the arguments and full output are not repeated. Re-read a
file if you need its exact contents.

There is a separate team chat for people talking to people. You never see it,
so do not refer to it.`;

/** The system prompt, plus what has already been folded into the summary. */
function systemPromptFor(workspaceId: string): string {
  const summary = currentSummary(workspaceId);
  if (!summary) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

Earlier parts of this conversation have been summarised to save room. This is
what happened before the messages you can see:

${summary}`;
}

/**
 * The thread so far, as model turns: everything older than the current summary
 * is represented by that summary, and the rest is verbatim.
 */
function buildMessages(workspaceId: string, upToId: string) {
  const history = verbatimMessages(workspaceId);
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const message of history) {
    if (message.status === 'cancelled' && message.kind === 'request') continue;

    // Condensed, but present: without these the model sees its own past claims
    // ("I created hello.py") with no record of the call behind them, and
    // concludes it never made it.
    if (message.kind === 'tool_call') {
      turns.push({ role: 'assistant', content: `(used ${message.content})` });
      continue;
    }
    if (message.kind === 'tool_result') {
      turns.push({ role: 'user', content: `(tool result: ${message.content})` });
      continue;
    }

    if (message.kind === 'request') {
      const author = message.author_id ? queries.getUser.get(message.author_id) : null;
      turns.push({
        role: 'user',
        content: `[${author?.display_name ?? 'Someone'}]: ${message.content}`,
      });
    } else if (message.kind === 'assistant' && message.content.trim().length > 0) {
      turns.push({ role: 'assistant', content: message.content });
    }
    if (message.id === upToId) break;
  }

  return turns;
}

/** Adds a request to the back of the queue and starts the worker if it is idle. */
export function enqueueRequest(workspaceId: string, userId: string, content: string): AiMessageDto {
  const id = newId();
  queries.insertAiMessage.run(id, workspaceId, userId, 'request', 'queued', content, now());
  announce(id, 'ai_message');
  void pump(workspaceId);
  return toDto(queries.getAiMessage.get(id)!);
}

/** A sender can cancel their own request while it is still queued. */
export function cancelRequest(messageId: string, userId: string): boolean {
  const result = queries.cancelQueuedAiMessage.run(messageId, userId);
  if (result.changes === 0) return false;
  announce(messageId, 'ai_message_updated');
  return true;
}

/** Anyone can stop the turn that is running. */
export function stopRunningTurn(workspaceId: string): boolean {
  const turn = running.get(workspaceId);
  if (!turn) return false;
  turn.abort.abort();
  return true;
}

export function runningTurnFor(workspaceId: string): RunningTurn | undefined {
  return running.get(workspaceId);
}

async function pump(workspaceId: string): Promise<void> {
  if (running.has(workspaceId)) return;

  const request = queries.nextQueuedRequest.get(workspaceId);
  if (!request) return;

  queries.setAiMessageStatus.run('running', request.id);
  announce(request.id, 'ai_message_updated');

  const assistantId = newId();
  queries.insertAiMessage.run(assistantId, workspaceId, null, 'assistant', 'running', '', now());
  announce(assistantId, 'ai_message');

  const abort = new AbortController();
  running.set(workspaceId, { requestId: request.id, assistantId, abort });

  let streamed = '';
  let answer = '';
  let failure: string | null = null;

  try {
    answer = await llm().run({
      system: systemPromptFor(workspaceId),
      messages: buildMessages(workspaceId, request.id),
      tools: AGENT_TOOLS,
      signal: abort.signal,
      onText: (text) => {
        streamed += text;
        broadcast(workspaceId, { type: 'ai_delta', id: assistantId, text });
      },
      useTool: async (name, input) => {
        // Everyone sees what the agent is doing, as it does it.
        const callId = newId();
        queries.insertAiMessage.run(
          callId,
          workspaceId,
          null,
          'tool_call',
          'running',
          describeToolCall(name, input),
          now(),
        );
        announce(callId, 'ai_message');

        const outcome = await runAgentTool(workspaceId, name, input, {
          aiMessageId: callId,
          signal: abort.signal,
        });

        queries.setAiMessageStatus.run('done', callId);
        announce(callId, 'ai_message_updated');

        const resultId = newId();
        queries.insertAiMessage.run(
          resultId,
          workspaceId,
          null,
          'tool_result',
          'done',
          outcome.isError ? `failed: ${outcome.output}` : summarise(name, outcome.output),
          now(),
        );
        announce(resultId, 'ai_message');

        return outcome;
      },
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      failure = (error as Error).message;
      console.error(`[ai] turn failed in ${workspaceId}:`, error);
    }
  } finally {
    running.delete(workspaceId);
  }

  const finalText = streamed || answer;

  if (abort.signal.aborted) {
    queries.setAiMessageContent.run(finalText, 'cancelled', assistantId);
  } else if (failure) {
    queries.setAiMessageContent.run(
      `${finalText}\n\nThe model call failed: ${failure}`.trim(),
      'done',
      assistantId,
    );
  } else {
    queries.setAiMessageContent.run(finalText, 'done', assistantId);
  }

  queries.setAiMessageStatus.run('done', request.id);
  announce(request.id, 'ai_message_updated');
  announce(assistantId, 'ai_message_updated');

  // Between turns, never during one: compressing here cannot race the queue.
  await summariseIfNeeded(workspaceId);

  // Next in line.
  void pump(workspaceId);
}

/**
 * On startup the in-memory queue is rebuilt from the database. Anything that
 * was mid-turn is lost, which is the documented cost of an in-memory queue.
 */
export function resumeQueuesOnStartup(): void {
  queries.cancelRunningAiMessages.run();
  for (const row of queries.listWorkspacesWithQueuedRequests.all()) {
    void pump(row.workspace_id);
  }
}
