import { loadIdentity } from './identity';

export type TreeNode =
  | { type: 'dir'; name: string; path: string; children: TreeNode[] }
  | { type: 'file'; name: string; path: string; size: number; editable: boolean };

export type Workspace = { id: string; name: string; inviteToken?: string };
export type Member = { id: string; displayName: string; role: string };
export type AiMessage = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  kind: 'request' | 'assistant' | 'tool_call' | 'tool_result';
  status: 'queued' | 'running' | 'done' | 'cancelled';
  content: string;
  createdAt: string;
};

export type ToolCall = {
  id: string;
  aiMessageId: string;
  command: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  decidedBy: string | null;
  decidedByName: string | null;
  output: string;
  createdAt: string;
};

export type JoinResult = { workspace: Required<Workspace>; user: { id: string; displayName: string }; token: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const identity = loadIdentity();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers['Content-Type'] = 'application/json';
  if (identity) headers.Authorization = `Bearer ${identity.token}`;

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body as T;
}

export const api = {
  me: () => request<{ id: string; displayName: string; token: string }>('/api/me'),

  createWorkspace: (name: string, displayName: string) =>
    request<JoinResult>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, displayName }),
    }),

  lookupInvite: (token: string) => request<{ workspace: Workspace }>(`/api/invites/${token}`),

  join: (token: string, displayName: string, asNewUser: boolean) =>
    request<JoinResult>(`/api/invites/${token}/join`, {
      method: 'POST',
      body: JSON.stringify({ displayName, asNewUser }),
    }),

  getWorkspace: (id: string) =>
    request<{ workspace: Required<Workspace>; members: Member[] }>(`/api/workspaces/${id}`),

  getFiles: (id: string) => request<{ tree: TreeNode[] }>(`/api/workspaces/${id}/files`),

  getThread: (id: string) =>
    request<{ messages: AiMessage[]; toolCalls: ToolCall[] }>(`/api/workspaces/${id}/ai`),

  decideToolCall: (id: string, callId: string, decision: 'approve' | 'deny') =>
    request<{ ok: true }>(`/api/workspaces/${id}/tool-calls/${callId}/${decision}`, {
      method: 'POST',
    }),

  getSummary: (id: string) =>
    request<{ summary: string | null; verbatimMessages: number; verbatimTokens: number }>(
      `/api/workspaces/${id}/summary`,
    ),

  sendRequest: (id: string, content: string) =>
    request<{ message: AiMessage }>(`/api/workspaces/${id}/ai`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  cancelRequest: (id: string, messageId: string) =>
    request<{ ok: true }>(`/api/workspaces/${id}/ai/${messageId}/cancel`, { method: 'POST' }),

  stopTurn: (id: string) =>
    request<{ stopped: boolean }>(`/api/workspaces/${id}/ai-stop`, { method: 'POST' }),

  createFile: (id: string, filePath: string) =>
    request<{ path: string }>(`/api/workspaces/${id}/files`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),
};
