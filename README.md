# Shared LLM Workspace

Implementation of [SPEC.md](SPEC.md). **Milestones 1–6 are done** — shared
editor, AI thread with queue, agent file tools, sandbox and personal terminals,
commands with approval, and team chat with presence. Milestones 7 and 8 are not
started.

## Running it

```bash
npm install
npm run dev        # server on :3001, client on :5173
```

Terminals need a Docker daemon. Any of Docker Desktop, Colima or a remote socket
works; the server finds the socket automatically, or set `DOCKER_SOCKET`. This
machine uses Colima:

```bash
colima start --cpu 2 --memory 3 --disk 12
```

If `npm install` leaves node-pty unbuilt (npm may skip install scripts), run
`cd node_modules/node-pty && npx node-gyp rebuild` once.

Open http://localhost:5173, create a workspace, and share the invite link shown
in the sidebar.

For real model answers, set a key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Without one, the server logs `LLM provider: stub` and the agent replies with a
canned message. The queue, attribution, streaming, cancel and Stop all work
either way.

## What is built

| Piece | Where |
| --- | --- |
| Express API, WebSocket upgrade routing | `server/src/index.ts` |
| Workspace events channel (file tree, members, AI thread) | `server/src/events.ts` |
| AI thread: per-workspace FIFO queue and worker | `server/src/aiThread.ts` |
| Agent tools: list, read, edit, create | `server/src/agentTools.ts` |
| Container per workspace, shells, `exec` | `server/src/container.ts` |
| Terminal WebSocket, one shell per connection | `server/src/terminals.ts` |
| Disk → Yjs watcher with three-way merge | `server/src/watcher.ts` |
| Approval cards: first click wins, 5-minute timeout | `server/src/approvals.ts` |
| The card people click | `client/src/components/ApprovalCard.tsx` |
| Team chat, on its own channel | `server/src/chat.ts` |
| Chat panel | `client/src/components/TeamChat.tsx` |
| xterm.js panel | `client/src/components/TerminalPanel.tsx` |
| The model interface (Anthropic, or a keyless stub) | `server/src/llm.ts` |
| AI thread panel, queue, cancel and Stop | `client/src/components/AiThread.tsx` |
| Hocuspocus Yjs sync, disk load and debounced write-back | `server/src/sync.ts` |
| Workspace folder, file tree, ignore rules | `server/src/files.ts` |
| SQLite schema (`users`, `workspaces`, `memberships`) | `server/src/db.ts` |
| Signed-cookie sessions and `can(user, action, workspace)` | `server/src/auth.ts` |
| Monaco bound to Yjs, live cursors | `client/src/components/CollaborativeEditor.tsx` |
| File tree, invite link, member list | `client/src/pages/WorkspacePage.tsx` |

Workspace files live in `data/workspaces/<workspace id>/`; the SQLite database is
`data/app.db`. Both are gitignored.

## Notes

- Identity is a signed cookie, plus a copy in `sessionStorage` so two tabs of one
  browser can act as two people. Open the invite link in a second tab and enter a
  different name.
- Each open file is one Yjs document named `<workspace id>/<path>`. Yjs text is
  written back to disk 600ms after the last edit (3s at the latest while someone
  keeps typing), and only when the bytes differ from what is already on disk.
- A second WebSocket, `/events`, carries workspace events. Today it tells every
  tab when a file is created or a member joins, so the file tree and member list
  update without a reload. Team chat and the AI thread share this channel from
  milestone 2 on; the agent and the file watcher broadcast on it in 3 and 4.
- `node_modules`, `.git`, binaries and files over 1 MB are never loaded into Yjs.
- Every message in the AI thread is a request. One runs at a time per
  workspace, in arrival order; the rest wait in a queue everyone can see. A
  sender can cancel their own queued request, and any member can Stop the turn
  that is running.
- Each request reaches the model as `[Name]: …`, so the agent knows who is
  asking. The system prompt explains that several people share the thread.
- The queue lives in memory and is rebuilt from the database on startup, so a
  restart loses only the turn that was running.
- The agent has four tools: `list_files`, `read_file`, `edit_file` and
  `create_file`. None needs approval; `run_command` does, and arrives in
  milestone 5.
- The agent writes through Yjs, never straight to disk. It opens a server-side
  connection to the same document your editor is bound to, and `edit_file`
  applies a delete plus an insert at one position — so someone typing elsewhere
  in that file keeps every keystroke and sees the change arrive live.
- `edit_file` replaces one exact string and fails if that string is missing or
  appears twice. The failure goes back to the model as text, and it re-reads and
  retries.
- Every tool call and its result is stored in the thread, so the whole team can
  see what the agent did, in order.
- Each workspace gets one long-lived container (`slw-<workspace id>`, image
  `node:22-alpine`, 1 GB / 2 CPUs) with its folder bind-mounted at
  `/workspace`. Every person opens their own shell in it through `docker exec`,
  so shell state is private but the filesystem is shared.
- A chokidar watcher feeds changes made outside the editor — terminals,
  formatters, installs — into the open Yjs documents. It applies *what changed
  on disk* rather than what disk now contains, anchored against the surrounding
  text, so unsaved typing survives a file being rewritten underneath it.
- Nothing stops idle containers yet; that is milestone 8. Remove them by hand
  with `docker rm -f $(docker ps -aq --filter label=slw.workspace)`.
- `run_command` is the only tool that needs a human. The agent asks, a card
  appears for everyone, and the first member to click decides it — the database
  update is conditional on the card still being pending, so a second click gets
  a 409 rather than overriding the first.
- The turn, and the queue behind it, waits while a card is pending. That is why
  the wait expires after five minutes (`APPROVAL_TIMEOUT_MS` to change it);
  denial and expiry both come back to the model as text, and it carries on.
- Approved commands run through `docker exec` in the agent's own shell, never in
  anyone's terminal, with a two-minute limit. Output streams into the card as it
  arrives, and the card records who decided.
- Cards still pending when the server stops are expired on startup, since nobody
  is left waiting to hear the answer.
- Team chat is for people talking to people, and the model never sees it. That
  is structural, not a filter: chat lives on its own WebSocket (`/chat`) in its
  own module, and no file the agent uses imports it or the `team_messages`
  queries. A test greps the agent modules to keep it that way.
- Presence rides on the events channel, since every open tab holds one whether
  or not the chat panel is showing. Two tabs count as one person.
- Rolling summaries and deploy arrive in later milestones; nothing here assumes
  they are absent.
