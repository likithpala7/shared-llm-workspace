import Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from './agentTools.js';

/**
 * The whole model surface, in one interface. Swapping the hosted API for a
 * self-hosted vLLM endpoint later means writing one more implementation of
 * this and nothing else.
 */
export type ToolOutcome = { output: string; isError: boolean };

export type LlmTurn = {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ToolDefinition[];
  /** Called with each chunk of text as it arrives. */
  onText: (text: string) => void;
  /** Runs one tool call and records it in the thread. */
  useTool: (name: string, input: unknown) => Promise<ToolOutcome>;
  /** Aborts the turn when a member presses Stop. */
  signal: AbortSignal;
};

export interface LlmClient {
  readonly name: string;
  /** Runs one turn, tool calls included, and resolves with the full answer. */
  run(turn: LlmTurn): Promise<string>;
  /** One tool-free call, used to merge rolling summaries between turns. */
  complete(system: string, prompt: string): Promise<string>;
}

/**
 * Defaults to the most capable model. ANTHROPIC_MODEL in .env swaps it for a
 * cheaper one while developing — claude-haiku-4-5 costs about a fifth of Opus.
 */
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';

/**
 * Thinking tokens are billed as output and dominate the cost of a turn.
 * AGENT_EFFORT=low or medium in .env spends less of them; unset means the
 * model's default (high).
 */
const EFFORT = process.env.AGENT_EFFORT;

/** API failures reach the thread, so say what went wrong in one readable line. */
function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'the API key was rejected — check ANTHROPIC_API_KEY in .env';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'the API is rate limiting us — try again in a moment';
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'could not reach the Anthropic API';
  }
  if (error instanceof Anthropic.APIError) {
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message;
    return detail ? `${error.status} — ${detail}` : error.message;
  }
  return (error as Error).message;
}

/** Stops a runaway loop; a turn that needs more steps than this is stuck. */
const MAX_STEPS = 12;

class AnthropicClient implements LlmClient {
  readonly name = `anthropic:${MODEL}`;
  private readonly client = new Anthropic();

  async complete(system: string, prompt: string): Promise<string> {
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  /**
   * The tool loop is written out rather than handed to the SDK's tool runner,
   * because milestone 5 has to pause it mid-loop for human approval and record
   * every call in the thread.
   */
  async run({ system, messages, tools, onText, useTool, signal }: LlmTurn): Promise<string> {
    const history: Anthropic.MessageParam[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    let answer = '';
    let emittedText = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break;

      // Text written before a tool call and text written after it are separate
      // paragraphs, not one run-on sentence.
      let firstChunkOfStep = true;
      const emit = (text: string) => {
        if (firstChunkOfStep && emittedText) {
          answer += '\n\n';
          onText('\n\n');
        }
        firstChunkOfStep = false;
        emittedText = true;
        onText(text);
      };

      const stream = this.client.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        ...(EFFORT ? { output_config: { effort: EFFORT as 'low' | 'medium' | 'high' } } : {}),
        system,
        tools,
        messages: history,
      });

      const stop = () => stream.abort();
      signal.addEventListener('abort', stop, { once: true });

      let message: Anthropic.Message;
      try {
        stream.on('text', emit);
        message = await stream.finalMessage();
      } catch (error) {
        if (signal.aborted) break;
        throw new Error(describeApiError(error));
      } finally {
        signal.removeEventListener('abort', stop);
      }

      // Spend is easy to lose track of; print it per call.
      const usage = message.usage;
      console.log(
        `[llm] ${MODEL} step ${step + 1}: in=${usage.input_tokens} out=${usage.output_tokens}` +
          (usage.cache_read_input_tokens ? ` cached=${usage.cache_read_input_tokens}` : ''),
      );

      answer += message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      // Thinking blocks are echoed back untouched, as the same model requires.
      history.push({ role: 'assistant', content: message.content });

      if (message.stop_reason !== 'tool_use') break;

      const calls = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      // Parallel calls run together and come back in a single user message;
      // splitting them would teach the model to stop batching.
      const results = await Promise.all(
        calls.map(async (call) => {
          const outcome = await useTool(call.name, call.input);
          return {
            type: 'tool_result' as const,
            tool_use_id: call.id,
            content: outcome.output,
            is_error: outcome.isError,
          };
        }),
      );

      history.push({ role: 'user', content: results });
    }

    return answer;
  }
}

/**
 * Used when no Anthropic credentials are configured. It is not a model: it
 * matches a few phrasings so the file tools, the queue and Stop can be
 * exercised without a key. Anything it does not recognise, it lists the files.
 */
class StubClient implements LlmClient {
  readonly name = 'stub (no ANTHROPIC_API_KEY set)';

  /**
   * Not a model: it keeps the lines that carry names, files and commands, which
   * is what the real summary is asked to preserve.
   */
  async complete(_system: string, prompt: string): Promise<string> {
    const lines = prompt.split('\n').filter((line) => line.trim());
    const kept = lines.filter((line) =>
      /asked:|replied:|used |Result:|Edited|Created|exit code|denied|approved/i.test(line),
    );
    const condensed = kept.map((line) => `- ${line.slice(0, 160)}`);
    return ['(stub summary — no ANTHROPIC_API_KEY set)', ...condensed].join('\n');
  }

  /** Streams a string a word at a time, spacing preserved exactly. */
  private async say(text: string, onText: (chunk: string) => void, signal: AbortSignal) {
    for (const chunk of text.match(/\s*\S+/g) ?? []) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (signal.aborted) return;
      onText(chunk);
    }
  }

  async run({ messages, onText, useTool, signal }: LlmTurn): Promise<string> {
    const last = messages[messages.length - 1]?.content ?? '';
    const who = /^\[([^\]]+)\]:/.exec(last)?.[1] ?? 'there';
    const request = last.replace(/^\[[^\]]+\]:\s*/, '');

    let answer = '';
    const emit = async (text: string) => {
      const chunk = answer ? ` ${text}` : text;
      await this.say(chunk, onText, signal);
      answer += chunk;
    };

    const fileMatch = /([\w./-]+\.[A-Za-z0-9]+)/.exec(request);
    const saying = /(?:saying|that says|with)\s+["“]?([^"”]+)["”]?\s*$/i.exec(request);

    // "add a README", "create notes/todo.md saying ..."
    if (/\b(create|add|make|write)\b/i.test(request) && /\b(file|readme|\.\w+)\b/i.test(request)) {
      const path = fileMatch?.[1] ?? 'README.md';
      const body = saying?.[1]?.trim() ?? `Created by the agent at ${new Date().toISOString()}.`;
      await emit(`${who}, creating ${path}.`);
      const outcome = await useTool('create_file', { path, content: `# ${path}\n\n${body}\n` });
      await emit(outcome.isError ? `That failed: ${outcome.output}` : outcome.output);
      return answer;
    }

    // "append a line to notes.md saying ..."
    if (/\b(append|add)\b/i.test(request) && fileMatch) {
      const path = fileMatch[1];
      const line = saying?.[1]?.trim() ?? 'A line from the agent.';
      await emit(`${who}, appending to ${path}.`);
      const read = await useTool('read_file', { path });
      if (read.isError) {
        await emit(`I could not read it: ${read.output}`);
        return answer;
      }
      const lines = read.output.split('\n').filter((l) => l.trim().length > 0);
      const anchor = lines[lines.length - 1] ?? '';
      const outcome = anchor
        ? await useTool('edit_file', {
            path,
            old_string: anchor,
            new_string: `${anchor}\n${line}`,
          })
        : await useTool('edit_file', { path, old_string: read.output, new_string: line });
      await emit(outcome.isError ? `That failed: ${outcome.output}` : outcome.output);
      return answer;
    }

    await emit(`${who}, here is what the workspace holds.`);
    const listing = await useTool('list_files', {});
    await emit(listing.output.split('\n').join(', '));
    await emit('(No ANTHROPIC_API_KEY is set, so this is the stub provider, not the model.)');
    return answer;
  }
}

let cached: LlmClient | null = null;

export function llm(): LlmClient {
  if (!cached) {
    // LLM_PROVIDER=stub forces the free stand-in even when a key is present.
    const useStub = process.env.LLM_PROVIDER === 'stub' || !process.env.ANTHROPIC_API_KEY;
    cached = useStub ? new StubClient() : new AnthropicClient();
    console.log(`LLM provider: ${cached.name}`);
  }
  return cached;
}
