export type ClearinghouseId = "claimmd" | "stedi";
export type ClearinghouseOperation = "transaction" | "era";

export interface ClearinghouseAdapter {
  readonly id: ClearinghouseId;
  submitProfessionalClaim(input: any): Promise<any>;
  checkEligibility(input: any): Promise<unknown>;
  checkClaimStatus(input: any): Promise<unknown>;
  listEras(input?: any): Promise<unknown>;
  retrieveEraData(eraId: string): Promise<unknown>;
}

export type ClearinghouseAdapters = Partial<Record<ClearinghouseId, ClearinghouseAdapter>>;

export interface ClearinghouseRoutingDefaults {
  transaction?: ClearinghouseId;
  era?: ClearinghouseId;
}

export function selectClearinghouseAdapter(
  adapters: ClearinghouseAdapters,
  requested: ClearinghouseId | undefined,
  operation: ClearinghouseOperation,
  defaults: ClearinghouseRoutingDefaults = {},
): ClearinghouseAdapter {
  const id = requested ?? defaults[operation] ?? "claimmd";
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(id === "claimmd"
      ? "Claim.MD adapter is not configured."
      : "Stedi clearinghouse adapter is not configured.");
  }
  return adapter;
}

export function isClearinghouseId(value: unknown): value is ClearinghouseId {
  return value === "claimmd" || value === "stedi";
}

export function clearinghouseRoutingFromEnv(env: Record<string, string | undefined>): Required<ClearinghouseRoutingDefaults> {
  const transaction = env.OSOD_CLEARINGHOUSE_DEFAULT || "claimmd";
  const era = env.OSOD_ERA_CLEARINGHOUSE || "claimmd";
  if (!isClearinghouseId(transaction) || !isClearinghouseId(era)) {
    throw new Error("OSOD clearinghouse routing values must be claimmd or stedi.");
  }
  return { transaction, era };
}
