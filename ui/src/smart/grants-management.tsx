import { useEffect, useState } from "react";

interface GrantRow {
  readonly grant_id: string;
  readonly app_name: string;
  readonly vendor: string;
  readonly scopes: readonly string[];
  readonly granted_at: string;
}

export function GrantsManagement() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null);

  useEffect(() => {
    void loadGrants();
  }, []);

  async function loadGrants() {
    const response = await fetch("/oauth2/grants", { credentials: "include" });
    if (!response.ok) {
      setGrants([]);
      return;
    }
    const json = (await response.json()) as { grants?: GrantRow[] };
    setGrants(json.grants ?? []);
  }

  async function revoke(grantId: string) {
    await fetch(`/oauth2/grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    setPendingGrantId(null);
    await loadGrants();
  }

  return (
    <main className="min-h-screen bg-bg text-white">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Authorized Apps</h1>
        </div>
        <div className="overflow-hidden rounded-lg border border-white/10">
          {grants.length === 0 ? (
            <div className="bg-bg-panel p-5 text-sm text-white/60">No active app grants.</div>
          ) : (
            <table className="w-full border-collapse bg-bg-panel text-left text-sm">
              <thead className="bg-white/5 text-white/60">
                <tr>
                  <th className="px-4 py-3 font-medium">App</th>
                  <th className="px-4 py-3 font-medium">Scopes</th>
                  <th className="px-4 py-3 font-medium">Granted</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {grants.map((grant) => (
                  <tr key={grant.grant_id}>
                    <td className="px-4 py-4">
                      <div className="font-medium">{grant.app_name}</div>
                      <div className="text-white/50">{grant.vendor}</div>
                    </td>
                    <td className="max-w-md px-4 py-4 font-mono text-xs text-white/70">
                      {grant.scopes.join(" ")}
                    </td>
                    <td className="px-4 py-4 text-white/70">{new Date(grant.granted_at).toLocaleString()}</td>
                    <td className="px-4 py-4 text-right">
                      {pendingGrantId === grant.grant_id ? (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className="rounded border border-white/20 px-3 py-1.5 text-xs text-white/80"
                            onClick={() => setPendingGrantId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="rounded bg-red-500 px-3 py-1.5 text-xs font-semibold text-white"
                            onClick={() => void revoke(grant.grant_id)}
                          >
                            Confirm
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-red-400/60 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/10"
                          onClick={() => setPendingGrantId(grant.grant_id)}
                        >
                          Revoke access
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
