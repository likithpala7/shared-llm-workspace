# Deploying

A runbook for a single VM. The reasoning behind these choices is in
[`../DEPLOY.md`](../DEPLOY.md); this file is the commands.

What ends up running:

```
  internet ──► Caddy (443, automatic TLS)
                 └─► node server/dist/index.js on 127.0.0.1:3001   (systemd: slw)
                       ├─ SQLite + workspace files at /srv/slw/data
                       └─ Docker ── one container per workspace
```

## 1. The box

Debian or Ubuntu, 2 vCPU and 4 GB to start. Sizing follows *concurrent
workspaces*, not users: each container is capped at 1 GB, so 8 GB holds about
five or six at once before anything else.

```bash
sudo apt update && sudo apt install -y git curl build-essential python3 docker.io caddy
```

`build-essential` and `python3` are not optional: `better-sqlite3` and
`node-pty` compile on install, and without them the first `npm ci` fails in a
way that looks unrelated.

Node 22 or newer:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2. A user that is not root

The server needs the Docker socket, which is root-equivalent — so it gets its
own account rather than running as root.

```bash
sudo useradd --system --create-home --home-dir /srv/slw --shell /bin/bash slw
sudo usermod -aG docker slw
sudo -u slw git clone https://github.com/likithpala7/shared-llm-workspace /srv/slw
```

## 3. Configuration

```bash
sudo -u slw cp /srv/slw/deploy/.env.production.example /srv/slw/.env
sudo -u slw chmod 600 /srv/slw/.env
sudo -u slw ./scripts/set-secret.sh COOKIE_SECRET --generate
sudo -u slw ./scripts/set-secret.sh ANTHROPIC_API_KEY --prompt
sudo -u slw editor /srv/slw/.env     # set ALLOWED_ORIGINS to your domain
```

The server refuses to start in production if `ALLOWED_ORIGINS`,
`COOKIE_SECRET` or `COOKIE_SECURE` are missing, and says which.

## 4. Caddy

Point an A record at the box first, then:

```bash
sudo cp /srv/slw/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/workspace.example.com/your.domain/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy gets the certificate itself. The long proxy timeouts matter: editors and
terminals hold sockets open for hours.

## 5. The service

```bash
sudo cp /srv/slw/deploy/slw.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo -u slw bash -c 'cd /srv/slw && npm ci && npm run build'
sudo systemctl enable --now slw
curl -s localhost:3001/api/health
```

Healthy looks like:

```json
{"ok":true,"provider":"anthropic:claude-opus-5","usingRealModel":true,"uptimeSeconds":3}
```

## 6. Backups

Workspace files and the database live in `/srv/slw/data` and are the only
things that cannot be rebuilt.

```bash
sudo apt install -y restic
# configure RESTIC_REPOSITORY and a password file, then:
sudo -u slw restic init
sudo crontab -u slw -e     # 17 3 * * *  /srv/slw/deploy/backup.sh
```

Restore is `restic restore latest --target /`, then `systemctl restart slw`.

## Updating

```bash
sudo -u slw /srv/slw/deploy/deploy.sh
```

It pulls, installs, typechecks, runs the unit tests, builds, restarts, and
waits for health — printing the last 40 log lines and failing if the service
does not come back.

## Watching it

```bash
sudo journalctl -u slw -f              # everything
sudo journalctl -u slw | grep '\[llm\]'    # model usage and cache hits per call
sudo journalctl -u slw | grep '\[reaper\]' # idle containers being stopped
docker ps --filter label=slw.workspace     # live workspaces
curl -s localhost:3001/api/health          # for an uptime check
```

`[llm]` lines carry `in=`, `out=`, `cache_read=` and `cache_write=` per call,
which is the only spend visibility there is until a cap exists.

## Known limits of this deployment

Worth being explicit, because none is a configuration mistake:

- **The invite link is the whole access-control model.** Whoever holds one can
  read the code, open a shell, and approve the agent's commands.
- **Everyone in a workspace shares its container.** Separate shells, shared PID
  and network namespaces and resource caps. Per-user containers are Phase 2.
- **A shell is remote code execution by design**, in an unprivileged container
  that is not a hardened sandbox.
- **Containers reach the internet.** No egress restrictions.
- **No spend cap.** Rate limits slow one person down; they do not bound a bill.

For people who already trust each other, behind a domain you control, this is
a reasonable place to stop. For strangers, work through Phase 2 in
[`../DEPLOY.md`](../DEPLOY.md) first.
