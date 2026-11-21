import { useEffect, useState } from 'react';
import { api, type Workspace } from '../lib/api';
import { loadIdentity, saveIdentity } from '../lib/identity';

export function Join({ inviteToken, navigate }: { inviteToken: string; navigate: (path: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = loadIdentity();

  useEffect(() => {
    api
      .lookupInvite(inviteToken)
      .then((result) => setWorkspace(result.workspace))
      .catch((caught) => setError((caught as Error).message));
  }, [inviteToken]);

  async function join(asNewUser: boolean, name: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.join(inviteToken, name, asNewUser);
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
      <div className="card">
        <h1>Join {workspace ? workspace.name : '…'}</h1>
        {existing && (
          <>
            <p className="muted">
              This tab is already {existing.displayName}.
            </p>
            <button type="button" disabled={busy} onClick={() => join(false, existing.displayName)}>
              Continue as {existing.displayName}
            </button>
            <hr />
          </>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void join(true, displayName);
          }}
        >
          <label>
            {existing ? 'Or join as someone else' : 'Your display name'}
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Bob"
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy || !workspace}>
            {busy ? 'Joining…' : 'Join workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
