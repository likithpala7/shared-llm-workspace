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

## Deploying

See [deploy/README.md](deploy/README.md) for the runbook, and
[DEPLOY.md](DEPLOY.md) for why it is shaped that way. In short: one VM, Caddy
in front for TLS, the server under systemd on the host (it needs the Docker
socket), workspace data on disk and backed up nightly.

## Tests

Three tiers, cheapest first.

**Unit** — pure logic, no server, no network, runs in a quarter of a second.
Covers the text-merge maths that keeps terminal writes from eating unsaved
typing, workspace path containment, and token signing.

```bash
npm test            # typecheck + unit tests
npm run test:unit
```

**End to end** — one suite per milestone plus security and resilience, against
a server that is already up. Real Yjs documents, real containers and shells,
and the real model when `ANTHROPIC_API_KEY` is set.

```bash
npm run dev              # in one terminal
npm run test:e2e         # in another
npm run test:e2e -- 04   # just the terminals suite
```

| Suite | What it holds the line on |
| --- | --- |
| `01-editor` | two tabs, live cursors, debounced writes, refresh |
| `02-thread` | queue order, attribution, cancel, Stop |
| `03-tools` | agent edits landing live while someone types |
| `04-terminals` | a shell each, and a formatter racing a typist |
| `05-approvals` | first click wins, denial, the queue blocking |
| `06-chat` | chat, presence, and the agent's lack of a read path |
| `07-summaries` | recall of who asked what, across merges |
| `08-security` | path traversal, cross-workspace access, forged tokens, oversized input |
| `09-resilience` | restarts: no duplication, queue resumes, nothing left pending |
| `10-hardening` | WebSocket origin checks, cookie-only access, rate limits, an unprivileged sandbox |
| `11-reaper` | idle containers stopped, attached shells spared, restarted on demand |

**Load** — how it behaves with a crowd. Run against a stub-provider server so
the shape is tested without spending.

```bash
EDITORS=50 EDITS=30 node tests/load/editors.mjs   # convergence under concurrency
REQUESTS=20 node tests/load/queue.mjs             # FIFO under a pile-on
TABS=40 node tests/load/sockets.mjs               # fan-out and presence
```

**Browser** — Playwright, driving two real browser contexts as two people.
Every layout regression this project has had was visual, so these assert what
a person can actually see and reach.

```bash
npm run test:ui
npx playwright test tests/ui/layout.spec.mjs
```

| Spec | What it holds the line on |
| --- | --- |
| `layout` | the page never scrolls; every message stays reachable inside its pane; neither tab is a sliver |
| `collaboration` | live typing, named remote cursors, file tree, presence, chat, unread badge |
| `approvals` | a card appears for the person who did not ask, and either may decide it |
| `terminal` | a shell runs a command and the result reaches the other person's tree |

Suites that assert what a *model* decided (`02`, `03`, `05`, `07`) check
`GET /api/health` first and skip themselves when the server is on the stub,
rather than passing for the wrong reason — the stub echoes requests back, so a
check like "the answer mentions ONE" would otherwise pass with no model
involved.

**Without a key**, the server falls back to its stub provider and the editor,
security, resilience, load and browser suites all still pass — that is what CI
runs on every push, so no API spend is needed to catch a regression.

`07-summaries` is skipped by default: it needs a server started with a small
budget so the rolling summary triggers in a handful of turns.

```bash
PORT=3006 SUMMARY_TOKEN_BUDGET=400 npx tsx server/src/index.ts
TEST_API=http://localhost:3006 node tests/e2e/07-summaries.mjs
```

They talk to a real model, so a full run costs a few cents and leaves test
workspaces in `data/` and stopped containers behind. Clean the containers with
`docker rm -f $(docker ps -aq --filter label=slw.workspace)`.

## What is built

| Piece | Where |
| --- | --- |
| Express API, `/api/health`, WebSocket upgrade routing | `server/src/index.ts` |
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

## Before exposing this publicly

Set `ALLOWED_ORIGINS`, `COOKIE_SECURE=true` and `TRUST_PROXY=true`. Without
the first, only localhost may open a WebSocket, so a deployment will appear to
load and then fail to sync.

What is **not** solved, and is not a configuration problem:

- **The invite link is the whole access-control model.** Anyone holding one can
  read the code, open a shell and approve the agent's commands. There are no
  roles, no revocation and no audit of who did what.
- **A shell is remote code execution by design.** The container is unprivileged
  and capped, but it is a normal Linux container, not a sandbox built to resist
  a determined attacker. A kernel escape reaches the host.
- **Containers have unrestricted network access.** Anything running in one can
  reach the internet and your local network.
- **Everyone in a workspace shares its container.** Shells are separate, but
  the PID namespace, network namespace, `/tmp` and resource caps are not — a
  teammate can see and signal your processes, and one runaway build starves
  the rest. Per-user containers are planned before strangers get a link.
- **Rate limits are per-process and in memory.** They slow one abuser down;
  they do not stop a distributed one, and they reset on restart.
- **Nothing reaps idle containers.** Twenty-two accumulated in a day of
  testing, each holding a 1 GB reservation.

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
- Requests carry a prompt-cache breakpoint. Every step of a tool loop resends
  the whole conversation plus the tool schemas, so input dominates the bill —
  across one day of development it was 79% of spend. Cached reads cost about a
  tenth of fresh ones. Watch the `[llm]` log lines for `cache_read=`.
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
  `node:22-alpine`, 1 GB / 2 CPUs, 512 pids) with its folder bind-mounted at
  `/workspace`. It runs as the host user, not root, with every capability
  dropped and `no-new-privileges` set — a shell there cannot write outside
  the workspace, mount anything, install packages or regain privilege. Every person opens their own shell in it through `docker exec`,
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
