/** Shared helpers for the end-to-end suites. */
export const API = process.env.TEST_API ?? 'http://localhost:3001';
export const WS_ORIGIN = API.replace(/^http/, 'ws');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reporter(name) {
  const results = [];
  return {
    check(label, ok, extra = '') {
      results.push(ok);
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
    },
    note(text) {
      console.log(`      ${text}`);
    },
    finish() {
      const failed = results.filter((r) => !r).length;
      console.log(
        failed === 0
          ? `\n${name}: ALL ${results.length} CHECKS PASSED`
          : `\n${name}: ${failed} of ${results.length} CHECKS FAILED`,
      );
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}

export async function call(method, path, body, token) {
  const response = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON. Hand back the raw text so a suite can assert on it.
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

/** A workspace with two members, as every suite needs. */
export async function twoPeople(name) {
  const alice = (await call('POST', '/api/workspaces', { name, displayName: 'Alice' })).body;
  const bob = (
    await call('POST', `/api/invites/${alice.workspace.inviteToken}/join`, {
      displayName: 'Bob',
      asNewUser: true,
    })
  ).body;
  // Opening the workspace is what starts its file watcher.
  await call('GET', `/api/workspaces/${alice.workspace.id}`, null, alice.token);
  return { workspaceId: alice.workspace.id, alice, bob };
}

export const thread = async (workspaceId, token) =>
  (await call('GET', `/api/workspaces/${workspaceId}/ai`, null, token)).body;

/**
 * Sends a request and waits for the thread to go quiet. Any approval card that
 * turns up unplanned is denied: a real model may ask for a command we did not
 * anticipate, and waiting out the five-minute timeout would stall the suite.
 */
export async function ask(workspaceId, token, content, { seconds = 300 } = {}) {
  await call('POST', `/api/workspaces/${workspaceId}/ai`, { content }, token);
  return settle(workspaceId, token, { seconds });
}

export async function settle(workspaceId, token, { seconds = 300, denyCards = true } = {}) {
  for (let i = 0; i < seconds * 4; i++) {
    const data = await thread(workspaceId, token);
    if (denyCards) {
      for (const card of data.toolCalls.filter((c) => c.status === 'pending')) {
        await call('POST', `/api/workspaces/${workspaceId}/tool-calls/${card.id}/deny`, {}, token);
      }
    }
    if (!data.messages.some((m) => m.status === 'running' || m.status === 'queued')) return data;
    await sleep(250);
  }
  throw new Error('turns never settled');
}

export async function waitFor(workspaceId, token, predicate, seconds = 120) {
  for (let i = 0; i < seconds * 4; i++) {
    const data = await thread(workspaceId, token);
    if (predicate(data)) return data;
    await sleep(250);
  }
  throw new Error('condition never met');
}

export const lastAnswer = (data) =>
  data.messages.filter((m) => m.kind === 'assistant').at(-1)?.content ?? '';

/**
 * Suites that assert what a model decided must not run against the stub. The
 * stub echoes the request back, so a check like "the answer mentions ONE"
 * passes without any model involved — a pass for the wrong reason, which is
 * worse than an honest skip.
 */
export async function requireRealModel(suite) {
  const health = await call('GET', '/api/health');
  if (health.status !== 200) {
    console.log(`SKIPPED  ${suite}: no server at ${API}`);
    process.exit(99);
  }
  if (!health.body.usingRealModel) {
    console.log(`SKIPPED  ${suite}: needs a real model, but the server is on ${health.body.provider}`);
    console.log('         Set ANTHROPIC_API_KEY (and unset LLM_PROVIDER=stub) to run it.');
    process.exit(99);
  }
}
