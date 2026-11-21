import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { spawn, type IPty } from 'node-pty';
import { queries } from './db.js';
import { workspaceDir } from './files.js';

/**
 * One long-lived container per workspace, with the workspace folder bind-mounted
 * at /workspace. Everything above this module only calls `openShell` and `exec`,
 * so swapping Docker for gVisor or a hosted sandbox later touches this file only.
 */

const IMAGE = process.env.WORKSPACE_IMAGE ?? 'node:22-alpine';
const MEMORY_BYTES = 1024 * 1024 * 1024; // 1 GB
const CPU_NANOS = 2_000_000_000; // 2 CPUs

/** Docker Desktop, Colima and a custom DOCKER_SOCKET all land here. */
function resolveSocket(): string {
  const candidates = [
    process.env.DOCKER_SOCKET,
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ''),
    '/var/run/docker.sock',
    path.join(os.homedir(), '.colima', 'default', 'docker.sock'),
    path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/var/run/docker.sock';
}

const socketPath = resolveSocket();
export const docker = new Docker({ socketPath });

const containerName = (workspaceId: string) => `slw-${workspaceId}`;

/** Serialises concurrent "start me a shell" calls for the same workspace. */
const starting = new Map<string, Promise<string>>();

async function pullImageIfMissing(): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [IMAGE] } });
  if (images.length > 0) return;

  console.log(`[docker] pulling ${IMAGE}…`);
  const stream = await docker.pull(IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error: Error | null) =>
      error ? reject(error) : resolve(),
    );
  });
  console.log(`[docker] pulled ${IMAGE}`);
}

async function createOrStart(workspaceId: string): Promise<string> {
  const name = containerName(workspaceId);
  const existing = docker.getContainer(name);

  try {
    const info = await existing.inspect();
    if (!info.State.Running) await existing.start();
    queries.setContainerId.run(info.Id, workspaceId);
    return info.Id;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }

  await pullImageIfMissing();

  const hostPath = workspaceDir(workspaceId);
  fs.mkdirSync(hostPath, { recursive: true });

  const container = await docker.createContainer({
    name,
    Image: IMAGE,
    // Something harmless that never exits, so the container outlives any shell.
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/workspace',
    Tty: false,
    HostConfig: {
      Binds: [`${hostPath}:/workspace`],
      Memory: MEMORY_BYTES,
      NanoCpus: CPU_NANOS,
      // Milestone 8 stops idle containers; nothing reaps them yet.
      RestartPolicy: { Name: 'no' },
    },
    Labels: { 'slw.workspace': workspaceId },
  });

  await container.start();
  await verifyMount(workspaceId, hostPath);
  queries.setContainerId.run(container.id, workspaceId);
  console.log(`[docker] workspace ${workspaceId} -> container ${container.id.slice(0, 12)}`);
  return container.id;
}

/**
 * Proves the workspace folder really is the same folder inside the container.
 *
 * If the Docker daemon cannot see the host path — a VM whose shared mounts do
 * not cover it, say — Docker silently creates an empty directory on its own
 * side instead. Everything then appears to work while terminals and the editor
 * quietly edit two different copies. Better to fail here, loudly.
 */
async function verifyMount(workspaceId: string, hostPath: string): Promise<void> {
  const sentinel = `.slw-mount-check-${Date.now()}`;
  fs.writeFileSync(path.join(hostPath, sentinel), 'ok', 'utf8');
  try {
    const container = docker.getContainer(containerName(workspaceId));
    const execution = await container.exec({
      Cmd: ['/bin/sh', '-c', `cat /workspace/${sentinel}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await execution.start({ hijack: true, Tty: true });
    let output = '';
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', () => resolve());
    });

    if (!output.includes('ok')) {
      throw new Error(
        `the workspace folder is not visible inside the container. ` +
          `Docker cannot see ${hostPath} — if the daemon runs in a VM (Colima, ` +
          `Docker Desktop), that path must be inside its shared mounts. Set ` +
          `DATA_DIR to a shared location.`,
      );
    }
  } finally {
    fs.rmSync(path.join(hostPath, sentinel), { force: true });
  }
}

export async function ensureContainer(workspaceId: string): Promise<string> {
  const inFlight = starting.get(workspaceId);
  if (inFlight) return inFlight;

  const promise = createOrStart(workspaceId).finally(() => starting.delete(workspaceId));
  starting.set(workspaceId, promise);
  return promise;
}

/** One interactive shell. Each person gets their own, in the shared container. */
export async function openShell(
  workspaceId: string,
  size: { cols: number; rows: number },
): Promise<IPty> {
  await ensureContainer(workspaceId);
  return spawn(
    process.env.DOCKER_BIN ?? 'docker',
    ['exec', '-it', '-w', '/workspace', containerName(workspaceId), '/bin/sh'],
    {
      name: 'xterm-color',
      cols: size.cols,
      rows: size.rows,
      env: { ...process.env, DOCKER_HOST: `unix://${socketPath}` } as Record<string, string>,
    },
  );
}

/**
 * Runs one command to completion in the agent's own shell, separate from
 * anyone's terminal. Milestone 5 puts an approval card in front of this.
 */
export async function exec(
  workspaceId: string,
  command: string,
  options: { timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  await ensureContainer(workspaceId);
  const container = docker.getContainer(containerName(workspaceId));

  const execution = await container.exec({
    Cmd: ['/bin/sh', '-lc', command],
    WorkingDir: '/workspace',
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await execution.start({ hijack: true, Tty: true });

  let output = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stream.destroy();
  }, options.timeoutMs ?? 120_000);

  await new Promise<void>((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      options.onOutput?.(text);
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', () => resolve());
  });
  clearTimeout(timeout);

  const details = await execution.inspect().catch(() => ({ ExitCode: null }));
  return { output, exitCode: details.ExitCode ?? null, timedOut };
}

export async function stopContainer(workspaceId: string): Promise<void> {
  try {
    await docker.getContainer(containerName(workspaceId)).remove({ force: true });
  } catch {
    // Already gone.
  }
}
