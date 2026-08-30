import { useCallback, useEffect, useState } from "react";
import { fhir } from "../../lib/fhir";
import {
  WORK_LANES,
  loadClaimWork,
  type WorkClaimGroup,
  type WorkEraGroup,
  type WorkLane,
  type WorkLaneId,
  type WorkProjection,
} from "../../lib/claim-work";
import {
  claimWorklistItem,
  resolveWorklistItem,
  type ClaimsApiOptions,
  type ClaimsWorklistItem,
} from "../../lib/claims-worklist";
import { submitStediClaimResubmission, type StediPayerClassification } from "../../lib/submit-claims";
import { ClaimsWorklistPanel } from "./ClaimsWorklist";

export function BillingWork({
  initialProjection,
  initialActiveLane = "holds",
  initialExpandedGroupKey,
  loadProjection = loadClaimWork,
}: {
  initialProjection?: WorkProjection;
  initialActiveLane?: WorkLaneId;
  initialExpandedGroupKey?: string;
  loadProjection?: (options?: ClaimsApiOptions) => Promise<WorkProjection>;
} = {}) {
  const [projection, setProjection] = useState<WorkProjection | undefined>(initialProjection);
  const [activeLane, setActiveLane] = useState<WorkLaneId>(initialActiveLane);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | undefined>(initialExpandedGroupKey);
  const [selectedEraItem, setSelectedEraItem] = useState<ClaimsWorklistItem>();
  const [error, setError] = useState<string>();
  const api = claimsApiOptions();

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      setProjection(await loadProjection(api));
    } catch (cause) {
      setProjection(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api.authorization, api.baseUrl, loadProjection]);

  useEffect(() => {
    if (!initialProjection) void refresh();
  }, [initialProjection, refresh]);

  const runEraAction = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
      setSelectedEraItem(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="min-h-screen bg-[var(--odos-page-ground)] px-5 py-6 text-[var(--odos-text)]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--odos-faint)]">Billing</div>
          <h1 className="mt-1 text-2xl font-semibold">Work</h1>
          <p className="mt-1 text-sm text-[var(--odos-muted)]">A repeated reason is one job. Open it once; work the batch.</p>
        </div>
        {projection?.status === "healthy" && (
          <div className="text-right text-xs text-[var(--odos-faint)]">
            Projection current as of <time dateTime={projection.lastSuccessfulAt}>{formatDateTime(projection.lastSuccessfulAt)}</time>
          </div>
        )}
      </header>

      {error && <div role="alert" className="mb-4 border border-red-400/40 bg-red-950/50 px-4 py-3 text-sm text-red-100">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
        <WorkLaneRail
          projection={projection}
          activeLane={activeLane}
          onSelect={(lane) => {
            setActiveLane(lane);
            setExpandedGroupKey(undefined);
          }}
        />
        <section aria-live="polite" className="min-w-0">
          {!projection && !error && <LoadingState />}
          {projection?.status === "degraded" && <DegradedState projection={projection} />}
          {projection?.status === "healthy" && (
            <HealthyLane
              lane={projection.lanes.find((lane) => lane.id === activeLane) ?? projection.lanes[0]}
              projectedAt={projection.lastSuccessfulAt}
              expandedGroupKey={expandedGroupKey}
              onToggle={(key) => setExpandedGroupKey((current) => current === key ? undefined : key)}
              onSelectEra={setSelectedEraItem}
            />
          )}
        </section>
      </div>

      {selectedEraItem && (
        <ClaimsWorklistPanel
          key={selectedEraItem.id}
          item={selectedEraItem}
          onClose={() => setSelectedEraItem(undefined)}
          onClaim={() => runEraAction(() => claimWorklistItem(selectedEraItem.id, api))}
          onResolve={(input) => runEraAction(() => resolveWorklistItem(selectedEraItem.id, input, api))}
          onVoid={(input) => runEraAction(() => voidEraClaim(selectedEraItem, input, api))}
          resubmissionApi={api}
        />
      )}
    </main>
  );
}

function WorkLaneRail({
  projection,
  activeLane,
  onSelect,
}: {
  projection?: WorkProjection;
  activeLane: WorkLaneId;
  onSelect: (lane: WorkLaneId) => void;
}) {
  const counts = projection?.status === "healthy"
    ? new Map(projection.lanes.map((lane) => [lane.id, lane.count]))
    : undefined;
  return (
    <nav aria-label="Work lanes" className="h-fit border border-[var(--odos-line)] bg-[var(--odos-surface)] p-2 lg:sticky lg:top-4">
      <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--odos-faint)]">Queues</div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">
        {WORK_LANES.map((lane) => (
          <button
            key={lane.id}
            type="button"
            aria-pressed={activeLane === lane.id}
            onClick={() => onSelect(lane.id)}
            className={activeLane === lane.id
              ? "flex items-center justify-between border border-[var(--odos-line-2)] bg-[var(--odos-elevated)] px-3 py-2 text-left text-sm font-semibold"
              : "flex items-center justify-between border border-transparent px-3 py-2 text-left text-sm text-[var(--odos-muted)] hover:bg-[var(--odos-elevated)]"}
          >
            <span>{lane.label}</span>
            {counts && <span data-lane-count={lane.id} className="tabular-nums text-xs text-[var(--odos-faint)]">{counts.get(lane.id) ?? 0}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}

function HealthyLane({
  lane,
  projectedAt,
  expandedGroupKey,
  onToggle,
  onSelectEra,
}: {
  lane: WorkLane;
  projectedAt: string;
  expandedGroupKey?: string;
  onToggle: (key: string) => void;
  onSelectEra: (item: ClaimsWorklistItem) => void;
}) {
  return (
    <>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--odos-line)] pb-3">
        <div>
          <h2 className="text-lg font-semibold">{lane.label}</h2>
          <p className="text-xs text-[var(--odos-faint)]">Grouped by reason · oldest untouched work first</p>
        </div>
        <div className="text-[11px] text-[var(--odos-faint)]">Arrow keys move · Space expands · Enter acts</div>
      </header>
      {lane.groups.length === 0 ? (
        <div className="border border-[var(--odos-line)] bg-[var(--odos-surface)] p-8 text-center">
          <p className="font-semibold">No {lane.label.toLowerCase()} work</p>
          <p className="mt-1 text-sm text-[var(--odos-muted)]">
            Projection current as of <time dateTime={projectedAt}>{formatDateTime(projectedAt)}</time>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {lane.groups.map((group) => group.kind === "claim" ? (
            <ClaimGroupCard
              key={group.key}
              group={group}
              expanded={expandedGroupKey === group.key}
              onToggle={() => onToggle(group.key)}
            />
          ) : (
            <EraGroupCard key={group.key} group={group} onSelect={onSelectEra} />
          ))}
        </div>
      )}
    </>
  );
}

function ClaimGroupCard({
  group,
  expanded,
  onToggle,
}: {
  group: WorkClaimGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article className="overflow-hidden border border-[var(--odos-line)] [background:var(--odos-card-gradient)]">
      <div className="grid items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <button type="button" aria-expanded={expanded} onClick={onToggle} className="min-w-0 text-left">
          <h3 className="truncate font-semibold">{group.title}</h3>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--odos-muted)]">
            <span>{group.count} {group.count === 1 ? "claim" : "claims"}</span>
            <span>{money(group.totalOutstandingCents)}</span>
            <span>oldest {group.oldestDaysBilled ?? 0}d</span>
          </p>
        </button>
        <button type="button" onClick={onToggle} className="scheduler-button">{expanded ? "Collapse" : "View claims"}</button>
        <button type="button" className="scheduler-button scheduler-button-primary">{group.primaryAction}</button>
      </div>
      {expanded && <ClaimRows group={group} />}
    </article>
  );
}

function ClaimRows({ group }: { group: WorkClaimGroup }) {
  return (
    <div className="overflow-x-auto border-t border-[var(--odos-line)]">
      <table className="w-full min-w-[940px] text-left text-sm">
        <thead className="bg-black/10 text-[10px] uppercase tracking-[0.12em] text-[var(--odos-faint)]">
          <tr>
            <th className="px-4 py-2">Claim</th>
            <th className="px-4 py-2">Patient</th>
            <th className="px-4 py-2">Payer</th>
            <th className="px-4 py-2 text-right">Days billed</th>
            <th className="px-4 py-2 text-right">Days touched</th>
            <th className="px-4 py-2">Last worked by</th>
            <th className="px-4 py-2">Money state</th>
            <th className="px-4 py-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--odos-line)]">
          {group.rows.map((row) => (
            <tr key={row.claimReference}>
              <td className="px-4 py-3 font-medium">{row.claimNumber}</td>
              <td className="px-4 py-3 text-[var(--odos-muted)]">{row.patient}</td>
              <td className="px-4 py-3 text-[var(--odos-muted)]">{row.payer}</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.daysSinceBilled}d</td>
              <td className="px-4 py-3 text-right tabular-nums">{row.daysSinceTouched === null ? "Never" : `${row.daysSinceTouched}d`}</td>
              <td className="px-4 py-3 text-[var(--odos-muted)]">{row.lastTouchedBy ?? "Never"}</td>
              <td className="px-4 py-3"><MoneyState status={row.status} /></td>
              <td className="px-4 py-3 text-right tabular-nums">{money(row.outstandingCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MoneyState({ status }: { status: string }) {
  const state = status === "submitted" || status === "queued" ? "charged" : "adjudicated";
  return <span className="inline-flex rounded-full border border-[var(--odos-line-2)] bg-[var(--odos-elevated)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--odos-muted)]">{state}</span>;
}

function EraGroupCard({ group, onSelect }: { group: WorkEraGroup; onSelect: (item: ClaimsWorklistItem) => void }) {
  return (
    <article className={group.kind === "legacy-remit"
      ? "border border-purple-300/30 bg-purple-950/15 p-4"
      : "border border-[var(--odos-line)] [background:var(--odos-card-gradient)] p-4"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{group.title}</h3>
          <p className="mt-1 text-xs text-[var(--odos-muted)]">{group.count} {group.count === 1 ? "remit item" : "remit items"}</p>
          {group.kind === "legacy-remit" && (
            <p className="mt-2 max-w-2xl text-sm text-purple-200">Visible for disposition only. It stays outside ODOS claim work and claim-watch alerts.</p>
          )}
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {group.items.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--odos-line)] pt-3 text-sm">
            <div>
              <div className="font-medium">{item.evidence.kind === "era" ? item.evidence.eraId : item.taskReference}</div>
              <div className="mt-0.5 text-xs text-[var(--odos-muted)]">
                {item.evidence.kind === "era" ? `PCN ${item.evidence.pcn}` : item.evidence.claimMdMessage}
              </div>
            </div>
            <button type="button" onClick={() => onSelect(item)} className="scheduler-button">Review remit</button>
          </div>
        ))}
      </div>
    </article>
  );
}

function DegradedState({ projection }: { projection: Extract<WorkProjection, { status: "degraded" }> }) {
  return (
    <section role="alert" className="border border-amber-300/40 bg-amber-950/40 p-5 text-amber-100">
      <h2 className="font-semibold">Work data hidden</h2>
      <p className="mt-1 text-sm">
        The claim projection is {projection.reason}. Counts and groups are hidden so old data cannot look current.
        {projection.lastSuccessfulAt
          ? <> The last successful projection was <time dateTime={projection.lastSuccessfulAt}>{formatDateTime(projection.lastSuccessfulAt)}</time>.</>
          : " It has not completed successfully yet."}
      </p>
    </section>
  );
}

function LoadingState() {
  return <div className="grid min-h-52 place-items-center border border-[var(--odos-line)] bg-[var(--odos-surface)] text-sm text-[var(--odos-muted)]">Loading Work projection…</div>;
}

async function voidEraClaim(
  item: ClaimsWorklistItem,
  input: { patientControlNumber: string; payerClassification?: StediPayerClassification },
  api: ClaimsApiOptions,
): Promise<void> {
  if (!item.focusReference?.startsWith("Claim/")) throw new Error("The work item is not linked to an original Claim.");
  const submitted = await submitStediClaimResubmission({
    originalClaimReference: item.focusReference,
    intent: "void",
    patientControlNumber: input.patientControlNumber,
    ...(input.payerClassification ? { payerClassification: input.payerClassification } : {}),
  }, api);
  if (!submitted.claimReference) throw new Error("The void submission did not return its new Claim reference.");
  await resolveWorklistItem(item.id, { disposition: "rebilled", claimReference: submitted.claimReference }, api);
}

function claimsApiOptions(): ClaimsApiOptions {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return {
    authorization: fhir.authHeader(),
    baseUrl: meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "",
  };
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
