# Shared LLM Workspace: MVP Spec

This file is the source of truth for the project. Build one milestone at a time, in the order given under "Build plan". Do not build anything listed under "Cut" or "Later".

## Summary

A web app where teammates share one workspace, one codebase and one LLM conversation. Everyone sees every request and every answer, the model knows who asked what, and its edits land in files the whole team is editing live.

The bare MVP proves one loop: two people in a browser ask the same agent for changes, watch it edit shared files, and approve the commands it wants to run. Everything that does not serve that loop is cut or stubbed.

The fastest route is one TypeScript server process, SQLite, one Docker container per workspace and a hosted LLM API. The core demo is reachable after the first three milestones, before any sandbox work.

## Decisions locked

These product rules are settled. Do not change them.

| Topic | Decision |
| --- | --- |
| Surface | Web app first. A VS Code extension is a later option. |
| Two chats | Team chat is for people talking to people. The AI thread is only for requests to the model. |
| Team chat privacy | The model never sees team chat. The agent code has no read path to it. |
| AI thread | Every message in it is a request. There is no "comment only" message type. |
| Turn order | First come, first served. One request per turn; later requests wait in a visible queue. |
| Attribution | Every request carries the sender's user id and display name, and the model is told who asked. |
| Conflicts | CRDTs (Yjs). The agent edits files as one more CRDT peer. |
| Terminals | Each person has their own terminal, all inside the same workspace container. |
| Approvals | Any member can approve or deny a command the agent wants to run. Roles come later. |
| Long threads | Rolling summaries replace older turns once the thread outgrows the context window. |

## MVP scope

Build the "Bare MVP" column. The "Later" column is context only.

| Area | Bare MVP | Later |
| --- | --- | --- |
| Sign-in | Invite link plus a display name, stored in a signed cookie | GitHub OAuth, real accounts |
| Workspaces | Create one, share its link | Workspace list, settings, deletion |
| Editor | Monaco with Yjs, file tree, live cursors | Tabs, search, diff view of agent edits |
| Files | One host folder per workspace, bind-mounted into the container | Object storage, git integration |
| Sandbox | One Docker container per workspace on the same machine | gVisor or Firecracker, or a hosted sandbox |
| Terminals | One shell per user through `docker exec` and node-pty | Multiple terminals per user, reconnect with scrollback |
| Team chat | Plain text messages, persisted | Threads, mentions, reactions |
| AI thread | Requests, streamed answers, visible queue, Stop button | Editing queued requests, branching threads |
| Agent tools | List, read, edit and create files; run a command with approval | Search, web access, multiple agents |
| Approvals | Any member, first click wins, 5-minute timeout | Roles, per-command allowlists |
| Summaries | One rolling summary per workspace | Pinned decisions, per-file memory |
| Database | SQLite in the server process | Postgres |
| Queue | In-memory, one per workspace | Redis or a jobs table, to survive restarts |
| Model | A hosted tool-calling LLM API behind one small interface | Self-hosted vLLM behind the same interface |
| Hosting | One VM running the server and Docker | Separate sandbox hosts, autoscaling |

Cut entirely for now: roles, billing, app preview through forwarded ports, file uploads, mobile layout, the VS Code extension.

## Architecture

One Node process does everything except run user code. Keep sync, chat, the agent and terminals in that one process; do not split into services.

```
 Browser: person A                     Browser: person B
 (editor, own terminal,                (editor, own terminal,
  team chat, AI thread)                 team chat, AI thread)
          |                                     |
          +------------------+------------------+
                             |
 +--------------------- Server: one Node process ---------------------+
 |                                                                    |
 |  Chat and events    Yjs sync   <---   Agent worker    Terminal     |
 |  (team chat chan.,  (Hocuspocus, (edits (FIFO queue,   bridge      |
 |   AI thread chan.)   one doc per  as a   tools,        (one shell  |
 |                      open file)   peer)  approvals,     per user,  |
 |                                          summaries)     docker     |
 |                                                         exec)      |
 +--------+----------------+----------------+----------------+--------+
          |                |                |                |
       SQLite         Workspace          LLM API          Docker
     (messages,        folder           (hosted,         container
      queue, tool    (files on host      tool calling;   (user shells,
      calls,          disk, one per      vLLM later)      approved
      summaries)      workspace)                          commands)
                           |                                 |
                           +---- mounted at /workspace ------+
```

Browsers only ever talk to the server. The agent worker is the one part that touches the model, and it reaches files through Yjs like any other editor.

### Stack

- **Language:** TypeScript everywhere, one repo with `client/` and `server/`.
- **Client:** React with Vite, Monaco with `y-monaco`, xterm.js, plain WebSocket for chat and events.
- **Server:** Node with Express, Hocuspocus for Yjs sync, `ws` for chat and events, node-pty and dockerode for terminals and containers.
- **Storage:** SQLite through `better-sqlite3`. Workspace files live in a host folder, `data/workspaces/<id>/`.
- **Sandbox:** one long-lived Docker container per workspace with that folder bind-mounted at `/workspace`.

### How files stay in sync

The workspace folder on disk is the meeting point between the editor, the agent and the terminals.

- Each open text file is one Yjs document, loaded from disk the first time anyone opens it.
- Editor and agent changes go into the Yjs document. The server writes the document back to disk on a short debounce.
- A file watcher (chokidar) picks up changes made from terminals, such as `npm install` or a formatter, and applies them to the Yjs document as a minimal diff.
- The server compares content before writing in either direction, so its own writes do not echo back as new edits.
- `node_modules`, `.git`, binaries and files over 1 MB are never loaded into Yjs. They still exist on disk for the terminals.

### Why the agent is a CRDT peer

The agent runs in the server process and opens a direct connection to the same Yjs documents. Its edits are small inserts and deletes on the shared text, not whole-file overwrites. A person typing in the same file while the agent edits keeps their keystrokes, and everyone sees the agent's change arrive live.

## AI thread mechanics

The AI thread is a strict request queue: one request in, one agent turn out, in arrival order.

### Requests and attribution

- Every message posted to the AI thread is a request. The input placeholder says so, and points people to team chat for discussion.
- Each request is stored with `user_id` and `display_name`, and reaches the model as a user turn that starts with `[Name]:`.
- The system prompt says several people share the session, that each turn names its sender, and that the model should address people by name.

### Queue

- Each workspace has one FIFO queue and one worker. The worker takes the oldest request, runs a full agent turn, then takes the next.
- A request that arrives during a turn is saved with status `queued` and shown to everyone in order, with its sender.
- A sender can cancel their own queued request. Anyone can press Stop on the running turn.
- The model sees the whole thread, so the second request in the queue can build on the answer to the first.

### Agent tools

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_files` | Lists the workspace tree from disk, minus ignored paths | No |
| `read_file` | Returns the current Yjs text, or the file on disk if not loaded | No |
| `edit_file` | Replaces one exact string in a file, applied as a Yjs insert and delete | No |
| `create_file` | Creates the file on disk and its Yjs document | No |
| `run_command` | Runs a shell command in the container with a 2-minute timeout | Yes |

### Approvals

1. The agent calls `run_command`. The server saves the call as `pending` and shows an approval card to everyone.
2. Any member clicks Approve or Deny. The server applies it with `UPDATE ... WHERE status = 'pending'`, so only the first click counts.
3. On approval the command runs through `docker exec` in the agent's own shell, not in anyone's terminal. Output streams into the card.
4. On denial, or after 5 minutes with no answer, the model gets a tool result saying the command was not run, and continues.
5. The card records who decided. Every permission check goes through one `can(user, action, workspace)` function, which returns true for any member today.

The queue stays blocked while a card is pending, which is why the timeout exists.

### Rolling summaries

- The model's context is: system prompt, the current summary, then the most recent turns verbatim.
- When the verbatim part passes a token budget, the server summarizes the oldest half and merges it into the stored summary.
- The summary keeps names: who asked for what, what was decided, which files changed, which commands ran.
- Summarizing runs between turns, never during one, so it cannot race the queue.

## Data model

Seven SQLite tables. File contents are not in the database; they live in the workspace folder.

| Table | Columns | Notes |
| --- | --- | --- |
| `users` | `id`, `display_name`, `created_at` | Created when someone joins through an invite link |
| `workspaces` | `id`, `name`, `invite_token`, `container_id`, `created_at` | The invite token is the only access control in the MVP |
| `memberships` | `user_id`, `workspace_id`, `role` | `role` is stored now (`owner` or `member`) and ignored until roles ship |
| `team_messages` | `id`, `workspace_id`, `user_id`, `content`, `created_at` | Never read by agent code |
| `ai_messages` | `id`, `workspace_id`, `author_id`, `kind`, `status`, `content`, `created_at` | `kind`: request, assistant, tool_call, tool_result. `status`: queued, running, done, cancelled. `author_id` is null for the agent |
| `tool_calls` | `id`, `ai_message_id`, `command`, `status`, `decided_by`, `output`, `created_at` | `status`: pending, approved, denied, timed_out |
| `ai_summaries` | `workspace_id`, `covers_up_to_message_id`, `content`, `updated_at` | One current row per workspace |

The queue is rebuilt on startup from `ai_messages` rows with status `queued`, so a restart loses only the turn that was running.

## Build plan

Eight milestones, ordered so the core demo (two people, one agent, shared files) works after milestone 3. Each ends with something two browser tabs can demonstrate. Finish and verify one before starting the next.

### 1. Shared editor

- Build: repo scaffold, Express and Hocuspocus server, workspace folder on disk, file tree, Monaco bound to Yjs, debounced write to disk, join by invite link with a display name.
- Done when: two tabs edit the same file with live cursors, and a refresh keeps the content.

### 2. AI thread with queue

- Build: `ai_messages` table, WebSocket events, per-workspace FIFO worker, streamed answers from the LLM API, `[Name]:` attribution, visible queue, cancel and Stop. No tools yet.
- Done when: two people send requests at once and get answers one after the other, each addressed by name.

### 3. Agent file tools

- Build: `list_files`, `read_file`, `edit_file`, `create_file`, with edits applied to the Yjs documents through a direct server connection.
- Done when: a request such as "add a README" shows the agent's edits appearing live in both tabs, including while someone types in the same file.

### 4. Sandbox and personal terminals

- Build: container per workspace with the folder mounted, node-pty over `docker exec`, xterm.js panel, one shell per user, chokidar watcher feeding disk changes into Yjs.
- Done when: each person runs commands in their own terminal, and a file created from a terminal appears in everyone's file tree.

### 5. Commands with approval

- Build: `run_command` tool, `tool_calls` table, approval card, atomic first-click-wins update, 5-minute timeout, output streamed into the card.
- Done when: the agent asks to run the tests, either person approves, and both see the output in the thread.

### 6. Team chat and presence

- Build: `team_messages` table on its own WebSocket channel, chat panel, list of who is online.
- Done when: people can talk beside the AI thread, and a search of the agent module shows no reference to team chat.

### 7. Rolling summaries

- Build: token estimate per turn, summarize-and-merge step between turns, `ai_summaries` table, a debug view of the current summary.
- Done when: a long session keeps working past the budget and the model still knows who asked for what earlier.

### 8. Deploy

- Build: one VM with Docker, the server behind Caddy for HTTPS, container CPU and memory limits, idle containers stopped after 30 minutes.
- Done when: a teammate on another network joins through a link and completes the full loop.

Milestones 6 and 7 are independent of 4 and 5, so they can move earlier or later without rework.

## Risks and shortcuts

The fast path is safe for a few trusted teammates. It is not safe to open to strangers until the first two rows are fixed.

| Shortcut | What can go wrong | Revisit when |
| --- | --- | --- |
| Plain Docker as the sandbox | Container escape or abuse of the host; the container has open network access | Before anyone unknown gets a link |
| Invite link as the only access control | Anyone with the link can read code and approve commands | Before storing any real project in it |
| File sync between Yjs and disk | Echo loops, or a terminal change overwriting unsaved typing | During milestone 4; test with a formatter running while someone types |
| `edit_file` by exact string match | The edit fails if a person changed that text a moment earlier | When failed edits become common; the agent re-reads and retries until then |
| In-memory queue | A server restart drops the turn in progress | When the server is deployed for more than demos |
| One shared container | Two people's dev servers collide on a port; one runaway process slows everyone | When app preview is added |
| No preview of running apps | People cannot see a web app the workspace is building | First feature after the MVP if the target user builds web apps |
| Any member can approve | A teammate approves a destructive command by mistake | When roles ship |
| Summaries lose detail | The model forgets an early decision after several merges | When sessions regularly run for hours; add pinned decisions |

## After the MVP

Leave these seams in place; do not build them yet.

- **Roles:** fill in `can(user, action, workspace)` using the `role` column that already exists.
- **Real accounts:** replace the display-name cookie with GitHub OAuth; `users.id` stays the key everywhere.
- **Stronger sandbox:** swap the container module for gVisor, Firecracker or a hosted sandbox; the rest of the server only calls `exec` and `openShell`.
- **App preview:** proxy a container port to a per-workspace URL.
- **Git:** clone a repo into the workspace folder on creation, then add commit and push as approved commands.
- **Self-hosted model:** point the LLM interface at a vLLM endpoint that supports tool calling.
- **VS Code extension:** a second client that speaks the same Yjs and WebSocket protocols as the web app.
- **Postgres and a durable queue:** needed once there is more than one server process.
