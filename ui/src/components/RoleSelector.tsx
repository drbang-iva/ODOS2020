import { ROLE_CONFIG, ROLE_IDS, type RoleId } from "../lib/roles";
import { useRole } from "../lib/role-context";

export function RoleSelector() {
  const { role, setRole } = useRole();

  return (
    <label className="flex items-center gap-2 text-xs text-white/45">
      <span>Role</span>
      <select
        data-testid="role-selector"
        value={role}
        onChange={(event) => setRole(event.target.value as RoleId)}
        className="h-9 rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none transition focus:border-brand"
      >
        {ROLE_IDS.map((roleId) => (
          <option key={roleId} value={roleId}>
            {ROLE_CONFIG[roleId].label}
          </option>
        ))}
      </select>
    </label>
  );
}
