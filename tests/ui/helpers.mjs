/** Shared steps for the browser tests. */
export const API = process.env.TEST_API ?? 'http://localhost:3001';

/** Creates a workspace through the API and returns its invite link. */
export async function createWorkspace(name) {
  const response = await fetch(`${API}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName: 'Owner' }),
  });
  const data = await response.json();
  return { workspaceId: data.workspace.id, inviteToken: data.workspace.inviteToken, owner: data };
}

/** Opens a page as a named person, joining through the invite link. */
export async function joinAs(page, inviteToken, displayName) {
  await page.goto(`/join/${inviteToken}`);
  // A cold first load can be slow; wait for the form rather than letting the
  // whole test budget drain on the default timeout.
  const name = page.getByPlaceholder('e.g. Bob');
  await name.waitFor({ state: 'visible', timeout: 30_000 });
  await name.fill(displayName);
  await page.getByRole('button', { name: 'Join workspace' }).click();
  await page.waitForURL(/\/w\//);
  await page.locator('.editor-host').waitFor();
}

/** Posts straight to the AI thread, bypassing the UI. */
export async function postRequest(workspaceId, token, content) {
  await fetch(`${API}/api/workspaces/${workspaceId}/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
  });
}
