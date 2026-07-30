import { ROLE_CONFIG, ROLE_IDS, type RoleId } from "../lib/roles";
import { useRole } from "../lib/role-context";
import { OdosSelect } from "./inputs/OdosSelect";

export function RoleSelector() {
  const { role, setRole } = useRole();

  return (
    <label className="flex items-center gap-2 text-xs text-white/45">
      <span>Role</span>
      <span data-testid="role-selector">
        <OdosSelect
          value={role}
          options={ROLE_IDS.map((roleId) => ({ value: roleId, label: ROLE_CONFIG[roleId].label }))}
          onChange={(value) => setRole(value as RoleId)}
          ariaLabel="Role"
        />
      </span>
    </label>
  );
}
