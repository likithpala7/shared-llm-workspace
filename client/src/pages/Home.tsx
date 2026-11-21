import { useState } from 'react';
import { api } from '../lib/api';
import { saveIdentity } from '../lib/identity';

export function Home({ navigate }: { navigate: (path: string) => void }) {
  const [workspaceName, setWorkspaceName] = useState('Demo workspace');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createWorkspace(workspaceName, displayName);
      saveIdentity({
        token: result.token,
        userId: result.user.id,
        displayName: result.user.displayName,
      });
      navigate(`/w/${result.workspace.id}`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Shared workspace</h1>
        <p className="muted">Create a workspace, then share its invite link.</p>
        <label>
          Workspace name
          <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} required />
        </label>
        <label>
          Your display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Alice"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </div>
  );
}
