import { requestAndRun } from './approvals.js';
import { broadcast } from './events.js';
import {
  createFile,
  fileExists,
  isEditable,
  listFilePaths,
  readFileText,
  resolveInWorkspace,
} from './files.js';
import { loadedDocumentText, withDocument } from './sync.js';

/**
 * The agent's tools. The four file tools run straight away; `run_command` waits
 * for a member to approve it.
 *
 * Every write goes through a Yjs document, never straight to disk, so a person
 * typing in the same file keeps their keystrokes and sees the agent's change
 * land live.
 */
export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description:
      'List every editable file in the workspace, as paths relative to the workspace root.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description:
      'Read one file. Returns what everyone is currently looking at, including unsaved edits.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact piece of text in a file. old_string must appear exactly once; ' +
      'include surrounding lines to make it unique. Read the file first.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'What to put in its place.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the given contents. Fails if the file already exists.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'The initial contents of the file.' },
      },
      required: ['path', 'content'],
    },
  },
];

export const RUN_COMMAND_TOOL: ToolDefinition = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace container, in /workspace. A member of ' +
    'the team must approve it first, and they see the exact command — so keep it ' +
    'to one clear step and explain anything surprising in your message. Times out ' +
    'after two minutes.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },
};

AGENT_TOOLS.push(RUN_COMMAND_TOOL);

export class ToolError extends Error {}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new ToolError(`${key} is required and must be a string`);
  return value;
}

/** Reads the live document when the file is open, and disk otherwise. */
function currentText(workspaceId: string, relPath: string): string {
  const live = loadedDocumentText(workspaceId, relPath);
  return live ?? readFileText(workspaceId, relPath);
}

async function listFiles(workspaceId: string): Promise<string> {
  const paths = listFilePaths(workspaceId);
  if (paths.length === 0) return 'The workspace is empty.';
  return paths.join('\n');
}

async function readFile(workspaceId: string, input: Record<string, unknown>): Promise<string> {
  const relPath = requireString(input, 'path');
  if (!fileExists(workspaceId, relPath)) throw new ToolError(`no such file: ${relPath}`);
  if (!isEditable(resolveInWorkspace(workspaceId, relPath))) {
    throw new ToolError(`${relPath} is not a text file this editor can open`);
  }
  return currentText(workspaceId, relPath);
}

async function editFile(workspaceId: string, input: Record<string, unknown>): Promise<string> {
  const relPath = requireString(input, 'path');
  const oldString = requireString(input, 'old_string');
  const newString = requireString(input, 'new_string');

  if (!fileExists(workspaceId, relPath)) throw new ToolError(`no such file: ${relPath}`);
  if (oldString === '') throw new ToolError('old_string must not be empty');

  return withDocument(workspaceId, relPath, (ytext) => {
    const text = ytext.toString();
    const first = text.indexOf(oldString);
    if (first === -1) {
      // Someone may have changed that text a moment ago. Re-read and retry.
      throw new ToolError(`old_string was not found in ${relPath}`);
    }
    if (text.indexOf(oldString, first + 1) !== -1) {
      throw new ToolError(
        `old_string appears more than once in ${relPath}; include more surrounding text`,
      );
    }
    // A delete and an insert, not a whole-file write: concurrent typing elsewhere
    // in the file survives.
    ytext.delete(first, oldString.length);
    ytext.insert(first, newString);
    return `Edited ${relPath}.`;
  });
}

async function createFileTool(
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<string> {
  const relPath = requireString(input, 'path');
  const content = typeof input.content === 'string' ? input.content : '';

  if (fileExists(workspaceId, relPath)) throw new ToolError(`${relPath} already exists`);
  try {
    createFile(workspaceId, relPath, content);
  } catch (error) {
    throw new ToolError((error as Error).message);
  }

  // Open the document so the file is live for everyone immediately, and tell
  // every tab to refresh its tree.
  await withDocument(workspaceId, relPath, () => undefined);
  broadcast(workspaceId, { type: 'files_changed' });
  return `Created ${relPath} (${content.length} characters).`;
}

export type ToolContext = {
  /** The thread row standing for this call, which the approval card hangs off. */
  aiMessageId: string;
  /** Stop ends a wait for approval as well as the model call. */
  signal: AbortSignal;
};

/** Runs one tool call. Tool failures come back as text for the model to read. */
export async function runAgentTool(
  workspaceId: string,
  name: string,
  rawInput: unknown,
  context: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'run_command':
        return await requestAndRun(
          workspaceId,
          context.aiMessageId,
          requireString(input, 'command'),
          context.signal,
        );
      case 'list_files':
        return { output: await listFiles(workspaceId), isError: false };
      case 'read_file':
        return { output: await readFile(workspaceId, input), isError: false };
      case 'edit_file':
        return { output: await editFile(workspaceId, input), isError: false };
      case 'create_file':
        return { output: await createFileTool(workspaceId, input), isError: false };
      default:
        return { output: `unknown tool: ${name}`, isError: true };
    }
  } catch (error) {
    return { output: (error as Error).message, isError: true };
  }
}

/** A one-line description of a call, for the thread. */
export function describeToolCall(name: string, rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  if (name === 'run_command' && typeof input.command === 'string') {
    return `run_command: ${input.command}`;
  }
  const target = typeof input.path === 'string' ? ` ${input.path}` : '';
  return `${name}${target}`;
}
