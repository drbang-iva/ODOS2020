import type { HealthcareService, Schedule } from "@medplum/fhirtypes";
import { useEffect, useMemo, useState } from "react";
import {
  FIND_OPEN_DEFAULT_LIMIT,
  findOpenSearchScopeKey,
  resourceDisplay,
  scheduleReference,
  visibleSchedulingVisitTypes,
  visitTypeCode,
  type ClinicMode,
  type SchedulingOpening,
} from "../../lib/scheduling";
import type { FindOpeningsInput } from "../../lib/scheduling-store";

export function FindOpenPanel({
  clinicMode,
  defaultDate,
  resources,
  timezoneOffset,
  visitTypes,
  onClose,
  onFind,
  onSelect,
}: {
  clinicMode: ClinicMode;
  defaultDate: string;
  resources: Schedule[];
  timezoneOffset: string;
  visitTypes: HealthcareService[];
  onClose: () => void;
  onFind: (input: FindOpeningsInput) => Promise<SchedulingOpening[]>;
  onSelect: (opening: SchedulingOpening, visitTypeCode: string) => void;
}) {
  const visibleVisitTypes = useMemo(
    () => visibleSchedulingVisitTypes(visitTypes, clinicMode),
    [clinicMode, visitTypes],
  );
  const firstVisitTypeCode =
    visibleVisitTypes.map((visitType) => visitTypeCode(visitType)).find(Boolean) ?? "";
  const [visitTypeCodeValue, setVisitTypeCodeValue] = useState(firstVisitTypeCode);
  const [resourceReference, setResourceReference] = useState("all");
  const [fromDate, setFromDate] = useState(defaultDate);
  const [openings, setOpenings] = useState<SchedulingOpening[]>([]);
  const scopeKey = useMemo(() => findOpenSearchScopeKey({ clinicMode, resources }), [clinicMode, resources]);
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visitTypeCodeValue && firstVisitTypeCode) {
      setVisitTypeCodeValue(firstVisitTypeCode);
    }
  }, [firstVisitTypeCode, visitTypeCodeValue]);

  useEffect(() => {
    if (scopeKey === lastScopeKey) {
      return;
    }
    if (openings.length > 0) {
      setOpenings([]);
      setStale(true);
    }
    setLastScopeKey(scopeKey);
  }, [lastScopeKey, openings.length, scopeKey]);

  async function search() {
    if (!visitTypeCodeValue) {
      setError("Select a visit type.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const results = await onFind({
        visitTypeCode: visitTypeCodeValue,
        ...(resourceReference !== "all" ? { resourceScheduleReference: resourceReference } : {}),
        from: `${fromDate}T00:00:00${timezoneOffset}`,
        limit: FIND_OPEN_DEFAULT_LIMIT,
      });
      setOpenings(results);
      setStale(false);
      setLastScopeKey(scopeKey);
    } catch (err) {
      setOpenings([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="border-b border-white/10 bg-[#11121c] px-4 py-3 text-white shadow-lg">
      <div className="flex flex-wrap items-end gap-3">
        <label className="scheduler-field min-w-56">
          <span>Visit Type</span>
          <select
            className="scheduler-input"
            value={visitTypeCodeValue}
            onChange={(event) => setVisitTypeCodeValue(event.target.value)}
          >
            {visibleVisitTypes.map((visitType) => {
              const code = visitTypeCode(visitType);
              return code ? (
                <option key={code} value={code}>
                  {visitType.name ?? code}
                </option>
              ) : null;
            })}
          </select>
        </label>
        <label className="scheduler-field min-w-52">
          <span>Resource</span>
          <select
            className="scheduler-input"
            value={resourceReference}
            onChange={(event) => setResourceReference(event.target.value)}
          >
            <option value="all">Any Resource</option>
            {resources.map((resource) => {
              const reference = scheduleReference(resource);
              return reference ? (
                <option key={reference} value={reference}>
                  {resourceDisplay(resource)}
                </option>
              ) : null;
            })}
          </select>
        </label>
        <label className="scheduler-field">
          <span>From Date</span>
          <input
            className="scheduler-input"
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </label>
        <button className="scheduler-button" type="button" disabled={loading} onClick={() => void search()}>
          Search
        </button>
        <button className="scheduler-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="mt-3 text-sm text-red-200">{error}</div>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {openings.map((opening, index) => (
          <button
            key={`${opening.scheduleReference}-${opening.start}-${index}`}
            className="border border-white/10 bg-white/[0.05] px-3 py-2 text-left text-sm hover:bg-white/[0.1]"
            type="button"
            onClick={() => onSelect(opening, visitTypeCodeValue)}
          >
            <span className="block font-semibold">{formatOpeningStart(opening.start)}</span>
            <span className="block text-xs text-white/55">{opening.actorDisplay ?? opening.scheduleReference}</span>
          </button>
        ))}
        {!loading && stale && openings.length === 0 && (
          <div className="text-sm text-white/45">Results are stale — search again.</div>
        )}
        {!loading && !stale && openings.length === 0 && (
          <div className="text-sm text-white/45">No openings loaded.</div>
        )}
        {loading && <div className="text-sm text-white/45">Searching openings...</div>}
      </div>
    </section>
  );
}

function formatOpeningStart(start: string): string {
  return `${start.slice(5, 10)} ${start.slice(11, 16)}`;
}
