import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_ROLE, ROLE_CONFIG, type RoleConfig, type RoleId } from "./roles";

interface RoleContextValue {
  role: RoleId;
  config: RoleConfig;
  setRole: (role: RoleId) => void;
}

const RoleContext = createContext<RoleContextValue | undefined>(undefined);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<RoleId>(DEFAULT_ROLE);
  const value = useMemo(
    () => ({
      role,
      config: ROLE_CONFIG[role],
      setRole,
    }),
    [role],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  const context = useContext(RoleContext);
  if (!context) {
    throw new Error("useRole must be used inside RoleProvider.");
  }
  return context;
}
