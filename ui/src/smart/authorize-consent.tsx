import { useMemo } from "react";

const SCOPE_LABELS: Record<string, string> = {
  "launch/patient": "Open this app for the selected patient",
  openid: "Confirm your identity",
  profile: "Read your profile",
  fhirUser: "Read your FHIR user identity",
  online_access: "Stay connected while you are signed in",
  offline_access: "Refresh access after you leave",
};

export function AuthorizeConsent() {
  const query = new URLSearchParams(window.location.search);
  const scopes = useMemo(() => (query.get("scope") ?? "").split(/\s+/).filter(Boolean), [query]);
  const clientName = query.get("client_name") ?? query.get("client_id") ?? "SMART app";
  const vendor = query.get("vendor") ?? "Local app vendor";
  const verification = query.get("verification") ?? "Practice-reviewed registration";
  const patient = query.get("patient") ?? "Current patient";

  return (
    <main className="min-h-screen bg-bg text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-6 py-10">
        <div>
          <p className="text-sm text-white/60">{vendor}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-normal">{clientName}</h1>
          <p className="mt-2 text-sm text-emerald-200">{verification}</p>
        </div>

        <div className="rounded-lg border border-white/10 bg-bg-panel p-5">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Requested Access</h2>
            <span className="rounded bg-white/10 px-2 py-1 text-sm text-white/70">{patient}</span>
          </div>
          <ul className="divide-y divide-white/10">
            {scopes.map((scope) => (
              <li key={scope} className="py-3">
                <div className="font-mono text-sm text-white">{scope}</div>
                <div className="mt-1 text-sm text-white/60">{scopeDescription(scope)}</div>
              </li>
            ))}
          </ul>
        </div>

        <form method="post" action="/oauth2/authorize/decision" className="flex flex-wrap justify-end gap-3">
          <input type="hidden" name="decision" value="deny" />
          <button
            type="submit"
            className="rounded border border-white/20 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/10"
          >
            Deny
          </button>
          <button
            type="submit"
            name="decision"
            value="approve"
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400"
          >
            Approve
          </button>
        </form>
      </section>
    </main>
  );
}

function scopeDescription(scope: string): string {
  if (SCOPE_LABELS[scope]) {
    return SCOPE_LABELS[scope];
  }
  const match = /^(patient|user|system)\/([A-Za-z*]+)\.(read|rs)$/.exec(scope);
  if (!match) {
    return "Requested app permission";
  }
  const [, owner, resource, permission] = match;
  const action = permission === "read" ? "Read" : "Read and search";
  return `${action} ${resource} records in the ${owner} scope`;
}
