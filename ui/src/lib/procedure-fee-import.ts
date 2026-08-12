import {
  authHeaders,
  clinicalGraphApiBase,
  clinicalGraphResponseError,
  type ClinicalGraphErrorBody,
} from "./clinical-graph-client";

export type ProcedureFeeCategory = "exam" | "refraction" | "cl-fitting" | "procedure";
export type FeeImportRouting = "insurance-billable" | "self-pay" | "scheduling-only";
export type FeeImportDecision = "match" | "create" | "skip";
export type FeeImportFlagClass =
  | "invalid-active-code-name"
  | "zero-price-contradiction"
  | "obsolete-or-superseded"
  | "category-required"
  | "routing-required"
  | "active-column-unmapped"
  | "laterality-dropped"
  | "invalid-price"
  | "invalid-source-boolean"
  | "concept-key-conflict";

export interface FeeImportColumnMapping {
  display?: string;
  category?: string;
  billingCode?: string;
  modifier?: string;
  price?: string;
  routing?: string;
  active?: string;
  zeroPrice?: string;
}

export interface FeeImportFlag {
  class: FeeImportFlagClass;
  message: string;
}

export interface FeeImportProposal {
  proposalId: string;
  sourceRows: number[];
  originalCode?: string;
  decision: FeeImportDecision;
  matchProcedureConceptKey?: string;
  matchSeeded?: boolean;
  display: string;
  category?: ProcedureFeeCategory;
  billingCode?: string;
  modifier?: string;
  priceCents?: number;
  routing?: FeeImportRouting;
  active: boolean;
  flags: FeeImportFlag[];
  reasons: string[];
}

export interface FeeImportMatchOption {
  procedureConceptKey: string;
  display: string;
  category?: ProcedureFeeCategory;
  seeded: boolean;
}

export interface FeeImportInspection {
  headers: string[];
  rowCount: number;
  suggestedMapping: FeeImportColumnMapping;
}

export interface FeeImportPreview {
  proposals: FeeImportProposal[];
  matchOptions: FeeImportMatchOption[];
  counts: { create: number; match: number; skip: number; flagged: number };
}

export interface FeeImportCommitOutcome {
  proposalId: string;
  status: "created" | "matched" | "skipped" | "failed";
  procedureConceptKey?: string;
  message: string;
}

export interface FeeImportCommitResult {
  outcomes: FeeImportCommitOutcome[];
  counts: { created: number; matched: number; skipped: number; failed: number };
}

export interface ProcedureFeeImportApi {
  inspect(csvText: string): Promise<FeeImportInspection>;
  propose(csvText: string, mapping: FeeImportColumnMapping): Promise<FeeImportPreview>;
  commit(proposals: FeeImportProposal[]): Promise<FeeImportCommitResult>;
}

export function procedureFeeImportApi(fetchImpl: typeof fetch = fetch): ProcedureFeeImportApi {
  const previewEndpoint = `${clinicalGraphApiBase()}/clinical-graph/fee-schedule/import/preview`;
  const commitEndpoint = `${clinicalGraphApiBase()}/clinical-graph/fee-schedule/import/commit`;
  return {
    inspect: (csvText) => post<FeeImportInspection>(fetchImpl, previewEndpoint, {
      action: "inspect",
      csvText,
    }),
    propose: (csvText, mapping) => post<FeeImportPreview>(fetchImpl, previewEndpoint, {
      action: "propose",
      csvText,
      mapping,
    }),
    commit: (proposals) => post<FeeImportCommitResult>(fetchImpl, commitEndpoint, { proposals }),
  };
}

async function post<T>(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: unknown,
): Promise<T> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json() as T & ClinicalGraphErrorBody;
  if (!response.ok) {
    throw clinicalGraphResponseError(response, parsed, `Fee schedule import failed: ${response.status}`);
  }
  return parsed;
}
