import { useState } from "react";
import {
  type FeeImportColumnMapping,
  type FeeImportCommitOutcome,
  type FeeImportFlagClass,
  type FeeImportMatchOption,
  type FeeImportProposal,
  type FeeImportPreview,
  type FeeImportRouting,
  type ProcedureFeeCategory,
  type ProcedureFeeImportApi,
} from "../../lib/procedure-fee-import";

const MAPPING_FIELDS: Array<{ key: keyof FeeImportColumnMapping; label: string }> = [
  { key: "display", label: "Display" },
  { key: "category", label: "Category" },
  { key: "billingCode", label: "Billing code" },
  { key: "modifier", label: "Modifier" },
  { key: "price", label: "Price" },
  { key: "routing", label: "Routing" },
  { key: "active", label: "Active source check" },
  { key: "zeroPrice", label: "Zero-price source check" },
];

const CATEGORIES: Array<{ value: ProcedureFeeCategory; label: string }> = [
  { value: "exam", label: "Exam" },
  { value: "refraction", label: "Refraction" },
  { value: "cl-fitting", label: "Contact lens fitting" },
  { value: "procedure", label: "Procedure" },
];

const CLINICAL_CATEGORIES = new Set<ProcedureFeeCategory>(["exam", "refraction", "cl-fitting", "procedure"]);
type ReviewFilter = "all" | "create" | "match" | "skip" | "flagged";

export function FeeScheduleImport({
  api,
  onCommitted,
}: {
  api: ProcedureFeeImportApi;
  onCommitted: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [inspection, setInspection] = useState<Awaited<ReturnType<ProcedureFeeImportApi["inspect"]>> | null>(null);
  const [mapping, setMapping] = useState<FeeImportColumnMapping>({});
  const [preview, setPreview] = useState<FeeImportPreview | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, FeeImportCommitOutcome>>({});
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [bulkRouting, setBulkRouting] = useState<FeeImportRouting>("insurance-billable");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspect(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.inspect(csvText);
      setInspection(result);
      setMapping(result.suggestedMapping);
      setPreview(null);
      setOutcomes({});
      setPriceDrafts({});
      setPriceErrors({});
      setSelectedIds(new Set());
      setReviewFilter("all");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function buildReview(): Promise<void> {
    if (!mapping.display) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.propose(csvText, mapping);
      setPreview(result);
      setOutcomes({});
      setPriceDrafts(Object.fromEntries(result.proposals.map((proposal) => [
        proposal.proposalId,
        proposal.priceCents === undefined ? "" : (proposal.priceCents / 100).toFixed(2),
      ])));
      setPriceErrors({});
      setSelectedIds(new Set());
      setReviewFilter("all");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (!preview || Object.keys(priceErrors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.commit(preview.proposals);
      setOutcomes(Object.fromEntries(result.outcomes.map((outcome) => [outcome.proposalId, outcome])));
      if (result.counts.created + result.counts.matched > 0) onCommitted();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function abandon(): void {
    setCsvText("");
    setInspection(null);
    setMapping({});
    setPreview(null);
    setOutcomes({});
    setPriceDrafts({});
    setPriceErrors({});
    setSelectedIds(new Set());
    setReviewFilter("all");
    setError(null);
  }

  function updateProposal(proposalId: string, change: Partial<FeeImportProposal>): void {
    setPreview((current) => current ? {
      ...current,
      proposals: current.proposals.map((proposal) =>
        proposal.proposalId === proposalId ? applyReviewChange(proposal, change) : proposal
      ),
    } : current);
  }

  function updatePrice(proposalId: string, value: string): void {
    setPriceDrafts((current) => ({ ...current, [proposalId]: value }));
    const parsed = parseDollars(value);
    if (!parsed.valid) {
      setPriceErrors((current) => ({
        ...current,
        [proposalId]: "Enter a nonnegative dollar amount with at most two decimal places.",
      }));
      return;
    }
    setPriceErrors((current) => {
      const next = { ...current };
      delete next[proposalId];
      return next;
    });
    updateProposal(proposalId, { priceCents: parsed.cents });
  }

  function setRowSelected(proposalId: string, selected: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(proposalId);
      else next.delete(proposalId);
      return next;
    });
  }

  function setAllSelected(selected: boolean): void {
    setSelectedIds(selected && preview ? new Set(preview.proposals.map((proposal) => proposal.proposalId)) : new Set());
  }

  function setSelectedRouting(routing: FeeImportRouting): void {
    setPreview((current) => current ? {
      ...current,
      proposals: current.proposals.map((proposal) =>
        selectedIds.has(proposal.proposalId) &&
        proposal.decision !== "skip" &&
        proposal.routing !== "scheduling-only"
          ? applyReviewChange(proposal, { routing })
          : proposal
      ),
    } : current);
  }

  function applyClinicalInsurancePreset(): void {
    if (!preview) return;
    const eligible = preview.proposals.filter((proposal) =>
      proposal.decision !== "skip" &&
      proposal.routing !== "scheduling-only" &&
      proposal.category !== undefined &&
      CLINICAL_CATEGORIES.has(proposal.category)
    );
    const eligibleIds = new Set(eligible.map((proposal) => proposal.proposalId));
    setSelectedIds(eligibleIds);
    setPreview({
      ...preview,
      proposals: preview.proposals.map((proposal) =>
        eligibleIds.has(proposal.proposalId)
          ? applyReviewChange(proposal, { routing: "insurance-billable" })
          : proposal
      ),
    });
  }

  const counts = preview ? {
    create: preview.proposals.filter((proposal) => proposal.decision === "create").length,
    match: preview.proposals.filter((proposal) => proposal.decision === "match").length,
    skip: preview.proposals.filter((proposal) => proposal.decision === "skip").length,
    flagged: preview.proposals.filter((proposal) => proposal.flags.length > 0).length,
  } : null;
  const visibleProposals = preview?.proposals.filter((proposal) =>
    reviewFilter === "all" ||
    reviewFilter === proposal.decision ||
    (reviewFilter === "flagged" && proposal.flags.length > 0)
  ) ?? [];
  const allSelected = Boolean(preview?.proposals.length) &&
    preview!.proposals.every((proposal) => selectedIds.has(proposal.proposalId));

  return (
    <section className="border border-slate-700 bg-slate-900/40 p-4">
      <h2 className="text-lg font-semibold text-slate-100">Import a fee schedule</h2>
      <p className="mt-2 text-sm text-amber-100">
        Modifier and routing are recorded only in this version. They do not currently change chart selection or claims. Side comes from each charge.
      </p>
      {error && <p className="mt-2 text-sm text-red-300" role="alert">{error}</p>}

      {!preview && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm text-slate-200">
            Upload CSV
            <input
              aria-label="Fee import CSV file"
              className="mt-1 block w-full"
              type="file"
              accept=".csv,text/csv"
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                setCsvText(await file.text());
                setInspection(null);
                setMapping({});
              }}
            />
          </label>
          <label className="block text-sm text-slate-200">
            Or paste CSV
            <textarea
              aria-label="Fee import CSV text"
              className="scheduler-input mt-1 min-h-28 w-full font-mono text-xs"
              value={csvText}
              onChange={(event) => {
                setCsvText(event.currentTarget.value);
                setInspection(null);
                setMapping({});
              }}
            />
          </label>
          <button
            aria-label="Inspect fee import CSV"
            className="scheduler-button"
            type="button"
            disabled={busy || !csvText.trim()}
            onClick={inspect}
          >
            Inspect CSV
          </button>
        </div>
      )}

      {inspection && !preview && (
        <div className="mt-5 space-y-3">
          <h3 className="font-medium text-slate-100">Map columns</h3>
          <p className="text-sm text-slate-300">{inspection.rowCount} rows found. Suggestions are editable.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {MAPPING_FIELDS.map((field) => (
              <label key={field.key} className="text-sm text-slate-200">
                {field.label}
                <select
                  aria-label={`Map ${field.key} column`}
                  className="scheduler-input mt-1 block w-full"
                  value={mapping[field.key] ?? ""}
                  onChange={(event) => setMapping((current) => ({
                    ...current,
                    [field.key]: event.currentTarget.value || undefined,
                  }))}
                >
                  <option value="">Not mapped</option>
                  {inspection.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>
          {!mapping.display && <p className="text-sm text-amber-200">Choose a display column before building review.</p>}
          <button
            aria-label="Build fee import review"
            className="scheduler-button"
            type="button"
            disabled={busy || !mapping.display}
            onClick={buildReview}
          >
            Build review
          </button>
        </div>
      )}

      {preview && counts && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium text-slate-100">Review proposals</h3>
            <p className="text-sm text-slate-200">
              {counts.create} create · {counts.match} match · {counts.skip} skip · {counts.flagged} flagged
            </p>
          </div>
          <div className="grid gap-3 border border-slate-700 p-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm text-slate-200">
              <input
                aria-label="Select all fee import rows"
                type="checkbox"
                checked={allSelected}
                onChange={(event) => setAllSelected(event.currentTarget.checked)}
              />
              Select all rows
            </label>
            <label className="text-sm text-slate-200">
              Review filter
              <select
                aria-label="Fee import review filter"
                className="scheduler-input mt-1 block w-full"
                value={reviewFilter}
                onChange={(event) => setReviewFilter(event.currentTarget.value as ReviewFilter)}
              >
                <option value="all">All rows</option>
                <option value="create">Create</option>
                <option value="match">Match</option>
                <option value="skip">Skip</option>
                <option value="flagged">Flagged</option>
              </select>
            </label>
            <button
              aria-label="Select all filtered fee rows"
              className="scheduler-button self-end"
              type="button"
              onClick={() => setSelectedIds((current) => new Set([
                ...current,
                ...visibleProposals.map((proposal) => proposal.proposalId),
              ]))}
            >
              Select all in filter
            </button>
            <button
              aria-label="Set all clinical rows to insurance-billable"
              className="scheduler-button self-end"
              type="button"
              onClick={applyClinicalInsurancePreset}
            >
              Set all clinical rows to insurance-billable
            </button>
            <label className="text-sm text-slate-200">
              Bulk routing
              <select
                aria-label="Bulk routing value"
                className="scheduler-input mt-1 block w-full"
                value={bulkRouting}
                onChange={(event) => setBulkRouting(event.currentTarget.value as FeeImportRouting)}
              >
                <option value="insurance-billable">Insurance billable</option>
                <option value="self-pay">Self-pay</option>
                <option value="scheduling-only">Scheduling only</option>
              </select>
            </label>
            <button
              aria-label="Bulk set routing for selected"
              className="scheduler-button self-end"
              type="button"
              disabled={selectedIds.size === 0}
              onClick={() => setSelectedRouting(bulkRouting)}
            >
              Set routing for selected
            </button>
          </div>
          <div className="space-y-4">
            {visibleProposals.map((proposal) => (
              <ProposalRow
                key={proposal.proposalId}
                proposal={proposal}
                matchOptions={preview.matchOptions}
                outcome={outcomes[proposal.proposalId]}
                priceValue={priceDrafts[proposal.proposalId] ?? ""}
                priceError={priceErrors[proposal.proposalId]}
                selected={selectedIds.has(proposal.proposalId)}
                onSelectedChange={(selected) => setRowSelected(proposal.proposalId, selected)}
                onChange={(change) => updateProposal(proposal.proposalId, change)}
                onPriceChange={(value) => updatePrice(proposal.proposalId, value)}
              />
            ))}
          </div>
          <div className="flex gap-3">
            <button
              aria-label="Commit reviewed fee import"
              className="scheduler-button"
              type="button"
              disabled={busy || Object.keys(priceErrors).length > 0}
              onClick={commit}
            >
              Commit reviewed proposals
            </button>
            <button aria-label="Abandon fee import review" className="scheduler-button" type="button" disabled={busy} onClick={abandon}>
              Abandon review
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ProposalRow({
  proposal,
  matchOptions,
  outcome,
  priceValue,
  priceError,
  selected,
  onSelectedChange,
  onChange,
  onPriceChange,
}: {
  proposal: FeeImportProposal;
  matchOptions: FeeImportMatchOption[];
  outcome?: FeeImportCommitOutcome;
  priceValue: string;
  priceError?: string;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onChange: (change: Partial<FeeImportProposal>) => void;
  onPriceChange: (value: string) => void;
}) {
  const match = proposal.decision === "match"
    ? matchOptions.find((option) => option.procedureConceptKey === proposal.matchProcedureConceptKey)
    : undefined;
  const immutableSeed = Boolean(match?.seeded);
  const rankByKey = new Map(proposal.matchRanking.map((rank, index) => [rank.procedureConceptKey, index]));
  const rankedMatchOptions = [...matchOptions].sort((left, right) =>
    (rankByKey.get(left.procedureConceptKey) ?? Number.MAX_SAFE_INTEGER) -
      (rankByKey.get(right.procedureConceptKey) ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.procedureConceptKey, right.procedureConceptKey)
  );
  const suggestedMatch = proposal.decision === "create"
    ? matchOptions.find((option) =>
      option.procedureConceptKey === proposal.suggestedMatchProcedureConceptKey
    )
    : undefined;
  return (
    <article className="border border-slate-700 p-3" data-proposal-id={proposal.proposalId}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">Source rows {proposal.sourceRows.join(", ")}</p>
        <label className="text-sm text-slate-200">
          <input
            aria-label={`Select fee row ${proposal.proposalId}`}
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelectedChange(event.currentTarget.checked)}
          />
          Select row
        </label>
      </div>
      {suggestedMatch && (
        <button
          aria-label={`Match ${proposal.proposalId} to suggested ${suggestedMatch.display}`}
          className="scheduler-button mt-2"
          type="button"
          onClick={() => onChange({
            decision: "match",
            matchProcedureConceptKey: suggestedMatch.procedureConceptKey,
            matchSeeded: suggestedMatch.seeded,
            display: suggestedMatch.display,
            category: suggestedMatch.category,
          })}
        >
          Resembles {suggestedMatch.seeded ? "seeded" : "existing"} concept {suggestedMatch.display} — match instead?
        </button>
      )}
      <div className="mt-2 grid gap-3 md:grid-cols-4">
        <label className="text-sm text-slate-200">
          Decision
          <select
            aria-label={`Decision for ${proposal.proposalId}`}
            className="scheduler-input mt-1"
            value={proposal.decision}
            onChange={(event) => onChange({ decision: event.currentTarget.value as FeeImportProposal["decision"] })}
          >
            <option value="create">Create</option>
            <option value="match">Match</option>
            <option value="skip">Skip</option>
          </select>
        </label>
        {proposal.decision === "match" && (
          <label className="text-sm text-slate-200">
            Match target
            <select
              aria-label={`Match target for ${proposal.proposalId}`}
              className="scheduler-input mt-1"
              value={proposal.matchProcedureConceptKey ?? ""}
              onChange={(event) => {
                const target = rankedMatchOptions.find((option) => option.procedureConceptKey === event.currentTarget.value);
                onChange({
                  matchProcedureConceptKey: target?.procedureConceptKey,
                  matchSeeded: target?.seeded,
                  ...(target ? { display: target.display, category: target.category } : {}),
                });
              }}
            >
              <option value="">Choose target</option>
              {rankedMatchOptions.map((option) => (
                <option key={option.procedureConceptKey} value={option.procedureConceptKey}>{option.display}</option>
              ))}
            </select>
          </label>
        )}
        {immutableSeed ? (
          <div className="text-sm text-slate-200">
            <p>Display: {match?.display}</p>
            <p>Category: {match?.category}</p>
          </div>
        ) : (
          <>
            <label className="text-sm text-slate-200">
              Display
              <input
                aria-label={`Display for ${proposal.proposalId}`}
                className="scheduler-input mt-1"
                value={proposal.display}
                onChange={(event) => onChange({ display: event.currentTarget.value })}
              />
            </label>
            <label className="text-sm text-slate-200">
              Category
              <select
                aria-label={`Category for ${proposal.proposalId}`}
                className="scheduler-input mt-1"
                value={proposal.category ?? ""}
                onChange={(event) => onChange({ category: event.currentTarget.value as ProcedureFeeCategory || undefined })}
              >
                <option value="">Choose category</option>
                {CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
              </select>
            </label>
          </>
        )}
        <label className="text-sm text-slate-200">
          Billing code
          <input
            aria-label={`Billing code for ${proposal.proposalId}`}
            className="scheduler-input mt-1"
            value={proposal.billingCode ?? ""}
            onChange={(event) => onChange({ billingCode: event.currentTarget.value || undefined })}
          />
        </label>
        <label className="text-sm text-slate-200">
          Modifier <span className="text-xs text-amber-200">recorded only</span>
          <input
            aria-label={`Modifier for ${proposal.proposalId}`}
            className="scheduler-input mt-1"
            value={proposal.modifier ?? ""}
            onChange={(event) => onChange({ modifier: event.currentTarget.value || undefined })}
          />
        </label>
        <label className="text-sm text-slate-200">
          Price
          <input
            aria-label={`Price for ${proposal.proposalId}`}
            className="scheduler-input mt-1"
            inputMode="decimal"
            value={priceValue}
            onChange={(event) => onPriceChange(event.currentTarget.value)}
          />
          {priceError && <span className="mt-1 block text-xs text-red-300" role="alert">{priceError}</span>}
        </label>
        <label className="text-sm text-slate-200">
          Routing <span className="text-xs text-amber-200">recorded only</span>
          <select
            aria-label={`Routing for ${proposal.proposalId}`}
            className="scheduler-input mt-1"
            value={proposal.routing ?? ""}
            onChange={(event) => onChange({
              routing: event.currentTarget.value as FeeImportProposal["routing"] || undefined,
            })}
          >
            <option value="">Choose routing</option>
            <option value="insurance-billable">Insurance billable</option>
            <option value="self-pay">Self-pay</option>
            <option value="scheduling-only">Scheduling only</option>
          </select>
        </label>
        <label className="text-sm text-slate-200">
          <input
            aria-label={`Active for ${proposal.proposalId}`}
            type="checkbox"
            checked={proposal.active}
            onChange={(event) => onChange({ active: event.currentTarget.checked })}
          />
          Active
        </label>
      </div>
      {proposal.originalCode && <p className="mt-2 text-xs text-slate-400">Original source code: {proposal.originalCode}</p>}
      {proposal.flags.map((flag) => <p className="mt-2 text-sm text-amber-200" key={flag.class}>{flag.message}</p>)}
      {proposal.reasons.map((reason) => <p className="mt-1 text-sm text-slate-300" key={reason}>{reason}</p>)}
      {outcome && <p className="mt-2 text-sm" data-status={outcome.status}>{outcome.status}: {outcome.message}</p>}
    </article>
  );
}

function parseDollars(value: string): { valid: true; cents?: number } | { valid: false } {
  const normalized = value.trim();
  if (!normalized) return { valid: true };
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return { valid: false };
  const [whole = "0", fraction = ""] = normalized.startsWith(".")
    ? ["0", normalized.slice(1)]
    : normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { valid: false };
  return { valid: true, cents: Number(cents) };
}

function applyReviewChange(
  proposal: FeeImportProposal,
  change: Partial<FeeImportProposal>,
): FeeImportProposal {
  const updated = { ...proposal, ...change };
  const resolved = new Set<FeeImportFlagClass>();
  if ("display" in change) {
    resolved.add("invalid-active-code-name");
    resolved.add("obsolete-or-superseded");
    resolved.add("concept-key-conflict");
  }
  if ("category" in change && updated.category) resolved.add("category-required");
  if ("priceCents" in change) {
    resolved.add("invalid-price");
    resolved.add("zero-price-contradiction");
  }
  if ("active" in change) {
    resolved.add("active-column-unmapped");
    resolved.add("invalid-source-boolean");
    if (!updated.active) resolved.add("invalid-active-code-name");
  }
  if ("matchProcedureConceptKey" in change && updated.matchProcedureConceptKey) {
    resolved.add("seeded-concept-uncoded");
    resolved.add("concept-key-conflict");
  }
  if (("decision" in change && updated.decision !== "create") || updated.matchSeeded) {
    resolved.add("seeded-concept-uncoded");
    if (updated.matchSeeded) resolved.add("category-required");
  }
  if ("routing" in change || "decision" in change) resolved.add("routing-required");
  const flags = updated.flags.filter((flag) => !resolved.has(flag.class));
  if (("routing" in change || "decision" in change) && updated.decision !== "skip" && !updated.routing) {
    flags.push({ class: "routing-required", message: "Routing must be reviewed before commit." });
  }
  return { ...updated, flags };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Fee schedule import failed.";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
