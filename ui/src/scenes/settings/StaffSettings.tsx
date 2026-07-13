import { useState, type FormEvent } from "react";
import { inviteStaff, type StaffInvitePayload, type StaffInviteResponse } from "../../lib/auth-api";
import {
  PRACTICE_ROLE_IDS,
  PRACTICE_ROLE_LABELS,
  type PracticeRoleId,
} from "../../lib/practice-roles";

export function StaffSettings({
  invite = inviteStaff,
}: {
  invite?: (payload: StaffInvitePayload) => Promise<StaffInviteResponse>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [roleId, setRoleId] = useState<PracticeRoleId>("front-desk");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<StaffInviteResponse>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setInvited(undefined);
    try {
      setInvited(await invite({ email, firstName, lastName, roleId }));
      setEmail("");
      setFirstName("");
      setLastName("");
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Staff invite failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6">
          <div className="text-xs uppercase tracking-wide text-white/45">Practice Admin</div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="mt-2 text-sm text-white/55">Invite a staff member and assign their practice role.</p>
        </header>
        <form className="grid gap-4 border border-white/10 bg-white/[0.035] p-5" onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span className="text-white/70">First name</span>
              <input className="border border-white/15 bg-black/25 px-3 py-2" required value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-white/70">Last name</span>
              <input className="border border-white/15 bg-black/25 px-3 py-2" required value={lastName} onChange={(event) => setLastName(event.target.value)} />
            </label>
          </div>
          <label className="grid gap-1 text-sm">
            <span className="text-white/70">Email</span>
            <input className="border border-white/15 bg-black/25 px-3 py-2" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-white/70">Role</span>
            <select className="border border-white/15 bg-[#11111b] px-3 py-2" value={roleId} onChange={(event) => setRoleId(event.target.value as PracticeRoleId)}>
              {PRACTICE_ROLE_IDS.map((role) => <option key={role} value={role}>{PRACTICE_ROLE_LABELS[role]}</option>)}
            </select>
          </label>
          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          {invited && (
            <p className="text-sm text-emerald-300" role="status">
              Invite sent to {invited.firstName} {invited.lastName} ({invited.email}) as {PRACTICE_ROLE_LABELS[invited.roleId]}.
            </p>
          )}
          <button className="w-fit bg-cyan-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send invite"}
          </button>
        </form>
      </div>
    </main>
  );
}
