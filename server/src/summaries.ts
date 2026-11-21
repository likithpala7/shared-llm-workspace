import { queries, type AiMessage } from './db.js';
import { llm } from './llm.js';

/**
 * The model's context is the system prompt, the current summary, then the most
 * recent turns verbatim. Once the verbatim part outgrows its budget, the oldest
 * half is summarised and merged into the stored summary.
 *
 * This runs between turns, never during one, so it cannot race the queue.
 */

/** Rough but stable: good enough to decide when to compress. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.7);
}

/** How much verbatim history to keep before compressing the oldest half. */
const TOKEN_BUDGET = Number(process.env.SUMMARY_TOKEN_BUDGET ?? 6000);

const SUMMARY_INSTRUCTIONS = `You keep the running memory of a shared coding workspace.

Merge the earlier summary (if any) with the new transcript into one summary that
a colleague could read to catch up. Keep, by name:

- who asked for what, and who decided things
- what was agreed, and anything explicitly rejected
- which files were created or changed, and how
- which commands were run, and whether they were approved, denied or failed
- anything still open or promised

Write compact prose or short bullets, no preamble, no sign-off. Prefer dropping
pleasantries over dropping a name, a filename or a decision.`;

function describe(message: AiMessage): string | null {
  if (message.status === 'cancelled' && message.kind === 'request') return null;

  if (message.kind === 'request') {
    const author = message.author_id ? queries.getUser.get(message.author_id) : null;
    return `${author?.display_name ?? 'Someone'} asked: ${message.content}`;
  }
  if (message.kind === 'assistant' && message.content.trim()) {
    return `Agent replied: ${message.content}`;
  }
  if (message.kind === 'tool_call') return `Agent used ${message.content}`;
  if (message.kind === 'tool_result') return `Result: ${message.content}`;
  return null;
}

/** Everything not yet folded into the summary. */
export function verbatimMessages(workspaceId: string): AiMessage[] {
  const all = queries.listAiMessages.all(workspaceId);
  const summary = queries.getSummary.get(workspaceId);
  if (!summary) return all;

  const covered = all.findIndex((message) => message.id === summary.covers_up_to_message_id);
  return covered === -1 ? all : all.slice(covered + 1);
}

export function currentSummary(workspaceId: string): string | null {
  return queries.getSummary.get(workspaceId)?.content ?? null;
}

export function verbatimTokens(workspaceId: string): number {
  return verbatimMessages(workspaceId).reduce(
    (total, message) => total + estimateTokens(describe(message) ?? ''),
    0,
  );
}

/**
 * Compresses the oldest half of the verbatim history into the stored summary,
 * when there is enough of it to be worth doing. Returns true if it ran.
 */
export async function summariseIfNeeded(workspaceId: string): Promise<boolean> {
  const verbatim = verbatimMessages(workspaceId);
  if (verbatim.length < 4) return false;

  const total = verbatim.reduce((sum, m) => sum + estimateTokens(describe(m) ?? ''), 0);
  if (total <= TOKEN_BUDGET) return false;

  // Oldest half, ending on a completed turn rather than mid-turn.
  let cut = Math.max(1, Math.floor(verbatim.length / 2));
  while (cut < verbatim.length && verbatim[cut - 1].kind !== 'assistant') cut += 1;
  if (cut >= verbatim.length) cut = Math.max(1, Math.floor(verbatim.length / 2));

  const oldest = verbatim.slice(0, cut);
  const transcript = oldest.map(describe).filter(Boolean).join('\n');
  if (!transcript) return false;

  const previous = currentSummary(workspaceId);
  const prompt = [
    previous ? `Earlier summary:\n${previous}` : 'There is no earlier summary yet.',
    `New transcript to fold in:\n${transcript}`,
  ].join('\n\n');

  let merged: string;
  try {
    merged = await llm().complete(SUMMARY_INSTRUCTIONS, prompt);
  } catch (error) {
    // A failed summary is not worth failing a turn over; try again next time.
    console.error(`[summary] ${workspaceId}:`, (error as Error).message);
    return false;
  }

  if (!merged.trim()) return false;

  queries.upsertSummary.run(
    workspaceId,
    oldest[oldest.length - 1].id,
    merged.trim(),
    new Date().toISOString(),
  );
  console.log(
    `[summary] ${workspaceId}: folded ${oldest.length} messages (~${total} tokens verbatim)`,
  );
  return true;
}
