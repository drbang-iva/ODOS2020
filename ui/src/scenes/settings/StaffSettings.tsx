import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  inviteStaff,
  loadStaffPermissions,
  saveStaffPermissions,
  type StaffInvitePayload,
  type StaffInviteResponse,
  type StaffPermissionAction,
  type StaffPermissionMember,
  type StaffPermissionsResponse,
} from "../../lib/auth-api";
import {
  PRACTICE_ROLE_IDS,
  PRACTICE_ROLE_LABELS,
  type PracticeRoleId,
} from "../../lib/practice-roles";

export function StaffSettings({
  invite = inviteStaff,
  loadPermissions = loadStaffPermissions,
  savePermissions = saveStaffPermissions,
}: {
  invite?: (payload: StaffInvitePayload) => Promise<StaffInviteResponse>;
  loadPermissions?: () => Promise<StaffPermissionsResponse>;
  savePermissions?: (membershipId: string, granted: string[], revoked: string[]) => Promise<StaffPermissionMember>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [roleId, setRoleId] = useState<PracticeRoleId>("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<StaffInviteResponse>();
  const [permissions, setPermissions] = useState<StaffPermissionsResponse>({ actions: [], members: [] });
  const [selectedReference, setSelectedReference] = useState("");
  const [draft, setDraft] = useState<StaffPermissionMember>();
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string>();
  const [permissionSaved, setPermissionSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void loadPermissions().then((loaded) => {
      if (!active) return;
      setPermissions(loaded);
      const first = loaded.members[0];
      setSelectedReference(first?.membershipReference ?? "");
      setDraft(first ? cloneMember(first) : undefined);
    }).catch((loadError) => {
      if (active) setPermissionError(loadError instanceof Error ? loadError.message : "Staff permissions could not be loaded.");
    });
    return () => { active = false; };
  }, [loadPermissions]);

  const actionGroups = useMemo(() => groupActions(permissions.actions), [permissions.actions]);

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

  function selectMember(reference: string) {
    setSelectedReference(reference);
    const member = permissions.members.find((candidate) => candidate.membershipReference === reference);
    setDraft(member ? cloneMember(member) : undefined);
    setPermissionError(undefined);
    setPermissionSaved(false);
  }

  function changeAction(action: StaffPermissionAction, checked: boolean) {
    if (!draft || actionDisabled(draft, action)) return;
    setDraft(applyActionToggle(draft, action, checked));
    setPermissionSaved(false);
  }

  function changeActions(actions: StaffPermissionAction[], checked: boolean) {
    if (!draft || draft.toggleImmune) return;
    setDraft(actions.reduce(
      (member, action) => actionDisabled(member, action) ? member : applyActionToggle(member, action, checked),
      draft,
    ));
    setPermissionSaved(false);
  }

  async function saveDraft() {
    if (!draft) return;
    setPermissionBusy(true);
    setPermissionError(undefined);
    setPermissionSaved(false);
    try {
      const membershipId = draft.membershipReference.split("/")[1] ?? "";
      const saved = await savePermissions(membershipId, draft.granted, draft.revoked);
      setPermissions((current) => ({
        ...current,
        members: current.members.map((member) => member.membershipReference === saved.membershipReference ? saved : member),
      }));
      setDraft(cloneMember(saved));
      setPermissionSaved(true);
    } catch (saveError) {
      setPermissionError(saveError instanceof Error ? saveError.message : "Staff permissions could not be saved.");
    } finally {
      setPermissionBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#060610] p-6 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <div className="text-xs uppercase tracking-wide text-white/45">Practice Admin</div>
          <h1 className="text-2xl font-semibold">Staff</h1>
          <p className="mt-2 text-sm text-white/55">Invite a staff member and assign their practice role.</p>
        </header>
        <section className="mb-8 border border-[color:var(--odos-line)] bg-bg-panel/70 p-5" data-permission-grid={true}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Per-person permissions</h2>
              <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Role permissions are the starting point. These switches apply only to the selected person.</p>
            </div>
            <label className="grid min-w-64 gap-1 text-sm">
              <span className="text-[color:var(--odos-muted)]">Staff member</span>
              <select
                aria-label="Staff member"
                className="border border-[color:var(--odos-line-2)] bg-bg-deep px-3 py-2"
                value={selectedReference}
                onChange={(event) => selectMember(event.target.value)}
              >
                {permissions.members.map((member) => <option key={member.membershipReference} value={member.membershipReference}>{member.display}</option>)}
              </select>
            </label>
          </div>

          {draft && (
            <div className="mt-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-[color:var(--odos-line)] bg-bg-deep p-3">
                <div>
                  <div className="font-medium">{draft.display}{draft.owner ? " · Practice owner" : ""}</div>
                  <div className="text-xs text-[color:var(--odos-muted)]">{draft.roles.map((role) => PRACTICE_ROLE_LABELS[role]).join(", ") || "No bound role"}</div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    aria-label="Grant all available actions"
                    type="checkbox"
                    disabled={draft.toggleImmune}
                    checked={permissions.actions.filter((action) => action.class === "grantable").every((action) => draft.effective.includes(action.action))}
                    onChange={(event) => changeActions(permissions.actions.filter((action) => action.class === "grantable"), event.target.checked)}
                  />
                  Grant all available actions
                </label>
              </div>

              {draft.toggleImmune && <p className="mb-4 border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100">The owner membership is toggle-immune. Its role and permissions cannot be changed here.</p>}
              {(draft.malformed || draft.ignoredGranted.length > 0 || draft.ignoredRevoked.length > 0) && (
                <p className="mb-4 border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-100">
                  Stored permission data needs review. Unusable entries were ignored and the role baseline remains in force.
                </p>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {actionGroups.map(([namespace, actions]) => {
                  const operable = actions.filter((action) => !actionDisabled(draft, action));
                  return (
                    <fieldset className="border border-[color:var(--odos-line)] p-4" key={namespace}>
                      <legend className="px-2 text-sm font-semibold capitalize">{namespace}</legend>
                      <label className="mb-3 flex items-center gap-2 border-b border-[color:var(--odos-line)] pb-3 text-xs uppercase tracking-wide text-[color:var(--odos-muted)]">
                        <input
                          aria-label={`Select all ${namespace} actions`}
                          type="checkbox"
                          disabled={draft.toggleImmune || operable.length === 0}
                          checked={operable.length > 0 && operable.every((action) => draft.effective.includes(action.action))}
                          onChange={(event) => changeActions(operable, event.target.checked)}
                        />
                        Select all
                      </label>
                      <div className="grid gap-3">
                        {actions.map((action) => {
                          const disabled = actionDisabled(draft, action);
                          return (
                            <label className="flex items-start gap-3 text-sm" key={action.action}>
                              <input
                                aria-label={`${action.action} for ${draft.display}`}
                                className="mt-1"
                                type="checkbox"
                                disabled={disabled}
                                checked={draft.effective.includes(action.action)}
                                onChange={(event) => changeAction(action, event.target.checked)}
                              />
                              <span>
                                <span className="block font-medium">{action.action}</span>
                                {action.reason && <span className="block text-xs text-[color:var(--odos-muted)]">{action.reason}</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  );
                })}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <button
                  aria-label="Save permission changes"
                  className="bg-cyan-300 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
                  type="button"
                  disabled={permissionBusy || draft.toggleImmune}
                  onClick={() => void saveDraft()}
                >
                  {permissionBusy ? "Saving…" : "Save permission changes"}
                </button>
                {permissionSaved && <span className="text-sm text-emerald-300" role="status">Permissions saved.</span>}
              </div>
            </div>
          )}
          {!draft && !permissionError && <p className="mt-4 text-sm text-[color:var(--odos-muted)]">No active staff memberships were found.</p>}
          {permissionError && <p className="mt-4 text-sm text-red-300" role="alert">{permissionError}</p>}
        </section>

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
            <select aria-label="Invite role" className="border border-white/15 bg-[#11111b] px-3 py-2" value={roleId} onChange={(event) => setRoleId(event.target.value as PracticeRoleId)}>
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

function cloneMember(member: StaffPermissionMember): StaffPermissionMember {
  return {
    ...member,
    roles: [...member.roles],
    roleActions: [...member.roleActions],
    granted: [...member.granted],
    revoked: [...member.revoked],
    effective: [...member.effective],
    ignoredGranted: [...member.ignoredGranted],
    ignoredRevoked: [...member.ignoredRevoked],
  };
}

function groupActions(actions: StaffPermissionAction[]): Array<[string, StaffPermissionAction[]]> {
  const groups = new Map<string, StaffPermissionAction[]>();
  for (const action of actions) {
    const namespace = action.action.split(".")[0] ?? action.action;
    groups.set(namespace, [...(groups.get(namespace) ?? []), action]);
  }
  return [...groups.entries()];
}

function actionDisabled(member: StaffPermissionMember, action: StaffPermissionAction): boolean {
  if (member.toggleImmune || action.class === "baseline" || action.class === "owner-only") return true;
  return action.class === "credential-bound" && !member.roleActions.includes(action.action);
}

function applyActionToggle(
  member: StaffPermissionMember,
  action: StaffPermissionAction,
  checked: boolean,
): StaffPermissionMember {
  const granted = new Set(member.granted);
  const revoked = new Set(member.revoked);
  const effective = new Set(member.effective);
  const roleHeld = member.roleActions.includes(action.action);
  if (checked) {
    revoked.delete(action.action);
    if (action.class === "grantable" && !roleHeld) granted.add(action.action);
    effective.add(action.action);
  } else {
    granted.delete(action.action);
    if (roleHeld) revoked.add(action.action);
    else revoked.delete(action.action);
    effective.delete(action.action);
  }
  return { ...member, granted: [...granted], revoked: [...revoked], effective: [...effective] };
}
