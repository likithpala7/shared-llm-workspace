import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// All seven of the spec's tables. The rest arrive with the milestones
// that use them.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    invite_token TEXT NOT NULL UNIQUE,
    container_id TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    user_id      TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    role         TEXT NOT NULL,
    PRIMARY KEY (user_id, workspace_id)
  );

  -- Team chat. Never read by agent code: no module under the agent's reach
  -- imports these queries, and nothing joins this table to ai_messages.
  CREATE TABLE IF NOT EXISTS team_messages (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    user_id      TEXT NOT NULL REFERENCES users(id),
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS team_messages_by_workspace
    ON team_messages (workspace_id);

  CREATE TABLE IF NOT EXISTS ai_messages (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    author_id    TEXT REFERENCES users(id),
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ai_messages_by_workspace
    ON ai_messages (workspace_id);

  -- One current summary per workspace, covering everything up to a message.
  CREATE TABLE IF NOT EXISTS ai_summaries (
    workspace_id            TEXT PRIMARY KEY REFERENCES workspaces(id),
    covers_up_to_message_id TEXT NOT NULL REFERENCES ai_messages(id),
    content                 TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id            TEXT PRIMARY KEY,
    ai_message_id TEXT NOT NULL REFERENCES ai_messages(id),
    command       TEXT NOT NULL,
    status        TEXT NOT NULL,
    decided_by    TEXT REFERENCES users(id),
    output        TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS tool_calls_by_message
    ON tool_calls (ai_message_id);
`);

export type User = { id: string; display_name: string; created_at: string };
export type Workspace = {
  id: string;
  name: string;
  invite_token: string;
  container_id: string | null;
  created_at: string;
};
export type Membership = { user_id: string; workspace_id: string; role: 'owner' | 'member' };

/** request and assistant are in use; tool_call and tool_result arrive in milestone 5. */
export type AiMessageKind = 'request' | 'assistant' | 'tool_call' | 'tool_result';
export type AiMessageStatus = 'queued' | 'running' | 'done' | 'cancelled';

export type AiSummary = {
  workspace_id: string;
  covers_up_to_message_id: string;
  content: string;
  updated_at: string;
};

export type TeamMessage = {
  id: string;
  workspace_id: string;
  user_id: string;
  content: string;
  created_at: string;
};

export type ToolCallStatus = 'pending' | 'approved' | 'denied' | 'timed_out';

export type ToolCall = {
  id: string;
  ai_message_id: string;
  command: string;
  status: ToolCallStatus;
  decided_by: string | null;
  output: string;
  created_at: string;
};

export type AiMessage = {
  id: string;
  workspace_id: string;
  author_id: string | null;
  kind: AiMessageKind;
  status: AiMessageStatus;
  content: string;
  created_at: string;
};

export const queries = {
  insertUser: db.prepare<[string, string, string]>(
    'INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)',
  ),
  getUser: db.prepare<[string], User>('SELECT * FROM users WHERE id = ?'),
  renameUser: db.prepare<[string, string]>('UPDATE users SET display_name = ? WHERE id = ?'),

  insertWorkspace: db.prepare<[string, string, string, string]>(
    'INSERT INTO workspaces (id, name, invite_token, created_at) VALUES (?, ?, ?, ?)',
  ),
  getWorkspace: db.prepare<[string], Workspace>('SELECT * FROM workspaces WHERE id = ?'),
  getWorkspaceByToken: db.prepare<[string], Workspace>(
    'SELECT * FROM workspaces WHERE invite_token = ?',
  ),

  setContainerId: db.prepare<[string, string]>(
    'UPDATE workspaces SET container_id = ? WHERE id = ?',
  ),

  insertMembership: db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO memberships (user_id, workspace_id, role) VALUES (?, ?, ?)',
  ),
  getMembership: db.prepare<[string, string], Membership>(
    'SELECT * FROM memberships WHERE user_id = ? AND workspace_id = ?',
  ),
  insertAiMessage: db.prepare<[string, string, string | null, string, string, string, string]>(
    `INSERT INTO ai_messages (id, workspace_id, author_id, kind, status, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  getAiMessage: db.prepare<[string], AiMessage>('SELECT * FROM ai_messages WHERE id = ?'),
  listAiMessages: db.prepare<[string], AiMessage>(
    'SELECT * FROM ai_messages WHERE workspace_id = ? ORDER BY rowid',
  ),
  setAiMessageStatus: db.prepare<[string, string]>(
    'UPDATE ai_messages SET status = ? WHERE id = ?',
  ),
  setAiMessageContent: db.prepare<[string, string, string]>(
    'UPDATE ai_messages SET content = ?, status = ? WHERE id = ?',
  ),
  /** First click wins: only a still-queued request can be cancelled. */
  cancelQueuedAiMessage: db.prepare<[string, string]>(
    "UPDATE ai_messages SET status = 'cancelled' WHERE id = ? AND author_id = ? AND status = 'queued'",
  ),
  nextQueuedRequest: db.prepare<[string], AiMessage>(
    `SELECT * FROM ai_messages
     WHERE workspace_id = ? AND kind = 'request' AND status = 'queued'
     ORDER BY rowid LIMIT 1`,
  ),
  listWorkspacesWithQueuedRequests: db.prepare<[], { workspace_id: string }>(
    "SELECT DISTINCT workspace_id FROM ai_messages WHERE status = 'queued'",
  ),
  /** A restart loses only the turn that was running. */
  cancelRunningAiMessages: db.prepare<[]>(
    "UPDATE ai_messages SET status = 'cancelled' WHERE status = 'running'",
  ),
  getSummary: db.prepare<[string], AiSummary>(
    'SELECT * FROM ai_summaries WHERE workspace_id = ?',
  ),
  upsertSummary: db.prepare<[string, string, string, string]>(
    `INSERT INTO ai_summaries (workspace_id, covers_up_to_message_id, content, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET
       covers_up_to_message_id = excluded.covers_up_to_message_id,
       content = excluded.content,
       updated_at = excluded.updated_at`,
  ),

  insertTeamMessage: db.prepare<[string, string, string, string, string]>(
    `INSERT INTO team_messages (id, workspace_id, user_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  getTeamMessage: db.prepare<[string], TeamMessage>('SELECT * FROM team_messages WHERE id = ?'),
  listTeamMessages: db.prepare<[string], TeamMessage>(
    'SELECT * FROM team_messages WHERE workspace_id = ? ORDER BY rowid',
  ),

  insertToolCall: db.prepare<[string, string, string, string]>(
    `INSERT INTO tool_calls (id, ai_message_id, command, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  ),
  getToolCall: db.prepare<[string], ToolCall>('SELECT * FROM tool_calls WHERE id = ?'),
  listToolCallsForWorkspace: db.prepare<[string], ToolCall>(
    `SELECT t.* FROM tool_calls t
     JOIN ai_messages m ON m.id = t.ai_message_id
     WHERE m.workspace_id = ?
     ORDER BY t.rowid`,
  ),
  /**
   * First click wins: the decision only lands while the card is still pending,
   * so two people clicking at once cannot both decide it.
   */
  decideToolCall: db.prepare<[string, string, string]>(
    "UPDATE tool_calls SET status = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
  ),
  expireToolCall: db.prepare<[string]>(
    "UPDATE tool_calls SET status = 'timed_out' WHERE id = ? AND status = 'pending'",
  ),
  appendToolCallOutput: db.prepare<[string, string]>(
    'UPDATE tool_calls SET output = output || ? WHERE id = ?',
  ),
  /** A restart leaves no one waiting on a card nobody can answer. */
  expireAllPendingToolCalls: db.prepare<[]>(
    "UPDATE tool_calls SET status = 'timed_out' WHERE status = 'pending'",
  ),

  listMembers: db.prepare<[string], User & { role: string }>(
    `SELECT u.*, m.role FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ?
     ORDER BY u.created_at`,
  ),
};
