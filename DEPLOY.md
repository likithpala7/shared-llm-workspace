# Running this as a service

Plan for taking the workspace from "runs on my laptop" to "other people use it",
cheaply and without pretending the security work is optional.

Written against the code as of milestone 7. Costs are November 2026 estimates;
verify list prices before you buy.

## The decision that shapes everything else

There are two different products here, and they cost very different amounts of
work:

| | Trusted deployment | Open service |
| --- | --- | --- |
| Who gets a link | teammates you know | strangers |
| Sandbox needed | plain Docker is defensible | hardened, or you will be mined for crypto |
| Auth | invite link | real accounts, roles |
| Who pays the model | you, predictably | you, unpredictably — this is the real risk |
| Work from here | ~1 day | ~1 week on top |

`SPEC.md` already says this in its risk table: plain Docker and
invite-link-only access are "not safe to open to strangers". Ship the trusted
deployment first. It is genuinely useful, and it is the same box you will
harden later.

## Phase 1 — a real deployment for people you trust (~1 day)

This is milestone 8 in the spec, and nothing in it is speculative.

**Topology: one VM, no containerisation of the server itself.**

```
  internet ──► Caddy (443, auto-TLS)
                 └─► Node server on 127.0.0.1:3001   (systemd)
                       ├─ SQLite + workspace files at /srv/slw/data
                       └─ Docker daemon ── one container per workspace
```

Run the server **on the host**, not in a container. It needs the Docker socket
(mounting that into a container is root-equivalent on the host) and it
bind-mounts workspace folders by host path — both become avoidable footguns the
moment the server is itself containerised. A systemd unit is simpler and cheaper
than the alternative.

Caddy is the cheapest correct way to get HTTPS: a two-line Caddyfile, automatic
certificates, and `reverse_proxy` passes WebSocket upgrades through untouched,
which all four channels (`/sync`, `/events`, `/terminal`, `/chat`) need.

```
workspace.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Checklist:

1. **Serve the built client from the server.** `index.ts` already serves
   `client/dist` when it exists, so this is `npm run build` at deploy time, not
   new code.
2. **systemd unit** with `EnvironmentFile=/srv/slw/.env`, `Restart=always`,
   `WorkingDirectory=/srv/slw`. Secrets stay in `.env` (`scripts/set-secret.sh`
   already manages it); never in the unit file.
3. **Deploy script**: `git pull && npm ci && npm run build && systemctl restart
   slw`. Good enough until there is a second server.
4. **Native modules**: `better-sqlite3` and `node-pty` compile on install. Put
   `build-essential`/`python3` on the box, or the first deploy fails in a
   confusing way. `node-pty` in particular needed a manual `node-gyp rebuild`
   during development.
5. **Idle container reaper** — the missing piece from milestone 8. Containers
   accumulate: during development seven were left running from test workspaces.
   Track last activity per workspace (any terminal frame, any `exec`) and stop
   containers idle for 30 minutes; `ensureContainer` already restarts a stopped
   container on next use, so this is safe.
6. **Backups.** Everything that matters is `data/`: SQLite, workspace files, Yjs
   state. Nightly `restic` to object storage, plus `sqlite3 .backup` for a
   consistent DB snapshot. ~$1/month of storage buys you not losing the team's
   work.
7. **Log rotation** on the systemd journal, and keep the per-call token log
   (`[llm] … in=… out=…`) — it is your only view of spend.

### What Phase 1 costs

Sizing is driven by concurrent *workspaces*, not users: each container is capped
at 1 GB / 2 CPUs (`container.ts`), and the server itself wants ~0.5 GB.

| VM | Concurrent workspaces | Indicative cost |
| --- | --- | --- |
| 2 vCPU / 4 GB | 2–3 | from ~€5.49/mo (Hetzner shared) |
| 4 vCPU / 8 GB | 5–6 | ~€15–35/mo depending on line and region |
| Dedicated vCPU | steadier under load | from €36.99/mo |

Add a domain (~$12/yr) and backup storage (~$1–5/mo). **Infrastructure floor is
roughly €10/month**; a comfortable small-team box lands at €20–40/month.

Hetzner is the cost-efficient default. Fly.io or Lightsail are fine and cost
more; anything serverless is the wrong shape, because this app holds long-lived
WebSockets and a Docker daemon.

### The cost that actually scales: the model

Infrastructure is nearly fixed. The Anthropic bill is not, and today **every
user's turns are billed to your key**. Measured from this codebase on
`claude-opus-5` ($5/$25 per million tokens in/out):

| Turn | Tokens | Cost |
| --- | --- | --- |
| Plain question | ~1.2k in, ~80 out | ~$0.008 |
| Four-step tool turn | ~6k in, ~340 out | ~$0.04 |

So roughly **25–125 turns per dollar**. Five people doing 50 turns a day is
~$12–60/month — the same order as the server, and unbounded if someone scripts
it. Three levers, two of which already exist:

- `ANTHROPIC_MODEL=claude-haiku-4-5` (~5× cheaper) and `AGENT_EFFORT=medium`
  (thinking tokens dominate output cost) — both already wired.
- Per-workspace spend caps — **not built**. See Phase 2.

## Phase 2 — before anyone you don't know gets a link (~2–4 days)

Do not skip these three. They are the difference between a demo and a liability.

**1. Harden the sandbox.** Today a workspace container runs as root with full
network access and no disk quota. On a shared host that is a crypto miner
waiting to happen, and a full disk is not hypothetical — this project hit one
during development. Cheapest meaningful hardening, all flags on the existing
`createContainer` call:

- `User: 'node'`, `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`
- `ReadonlyRootfs: true` with a tmpfs for `/tmp`, `PidsLimit`, `--ulimit nofile`
- storage quota per container, or a dedicated data volume per workspace
- network: egress-filtered or `--network none` by default, opened per workspace
  on request. This is the single highest-value change, and the one most likely
  to annoy users — decide deliberately.
- gVisor (`runsc`) as the runtime if the host supports it; the spec names this
  as the eventual answer and `container.ts` is the only file that changes.

**2. Real accounts.** The invite token is currently the whole access control
model: anyone with the link can read the code, open a shell, and approve the
agent's commands. GitHub OAuth is the planned replacement and the seam exists —
`users.id` stays the key, and `can(user, action, workspace)` is already the
single permission check, with a `role` column stored and ignored. Make
`approve_command` owner-only at the same time.

**3. Cap the spend.** Pick one:

- **Bring your own key** — each workspace stores its own Anthropic key. Cleanest
  for a side project: your cost stays at the VM, and nobody can run up your
  bill. `llm()` currently caches one client process-wide, so this means making
  the client per-workspace.
- **Operator key with hard caps** — meter tokens per workspace (the data is
  already logged), refuse new turns past a monthly ceiling, and show the budget
  in the UI. More work, better product.

Also worth doing here: rate-limit workspace creation, and log who ran what.

## Phase 3 — only when something actually hurts

Deliberately deferred; none of it is needed for a small team.

- **Postgres + a durable queue.** SQLite in one process is fine for dozens of
  users. The in-memory queue loses the running turn on restart — already handled
  gracefully, and only worth fixing when deploys are frequent.
- **Separate sandbox hosts**, once untrusted code and the control plane sharing
  a kernel stops being acceptable.
- **App preview** (proxying a container port to a per-workspace URL) — the first
  thing users will ask for if they are building web apps.
- Multiple server processes, which is what forces Postgres and Redis.

## Decide these before Phase 2, not during

1. **Who pays for the model?** BYO key is dramatically cheaper and simpler for
   you. Operator-pays is a better product and needs metering and a billing story.
2. **Do untrusted users get terminals at all?** Shells are the largest part of
   the attack surface. Editor + agent with approval-gated commands is a coherent,
   much safer product on its own.
3. **Where does the data live?** Workspace files are other people's source code.
   Pick a region, say so, and keep backups encrypted.
