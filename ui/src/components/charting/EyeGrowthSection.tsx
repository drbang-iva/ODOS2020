import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  AxialGrowthChart,
  type AxialGrowthReading,
  type AxialGrowthReferenceDataset,
  type MyopiaReferencePopulation,
} from "./AxialGrowthChart";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface EyeInput {
  axialLength: string;
  cornealRadius: string;
}

interface EyeGrowthHistory {
  referencePopulation: MyopiaReferencePopulation;
  patientSex: "MALE" | "FEMALE" | null;
  birthDate: string;
  readings: AxialGrowthReading[];
  referenceDataset: AxialGrowthReferenceDataset | null;
  noReferenceMessage: string | null;
}

const EMPTY_EYES: Record<"OD" | "OS", EyeInput> = {
  OD: { axialLength: "", cornealRadius: "" },
  OS: { axialLength: "", cornealRadius: "" },
};

export function EyeGrowthSection({ patientReference, encounterReference, onSaved }: Props) {
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [eyes, setEyes] = useState<Record<"OD" | "OS", EyeInput>>(EMPTY_EYES);
  const [biometryMethod, setBiometryMethod] = useState<"OPTICAL_BIOMETRY" | "ULTRASOUND_A_SCAN">("OPTICAL_BIOMETRY");
  const [instrument, setInstrument] = useState("");
  const [history, setHistory] = useState<EyeGrowthHistory | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBusy("load");
    setError(null);
    fetch(
      `${clinicalGraphApiBase()}/clinical-graph/eye-growth/history?${new URLSearchParams({ patient: patientReference })}`,
      { headers: authHeaders(), signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response, "Eye growth request failed"));
        return response.json() as Promise<EyeGrowthHistory>;
      })
      .then(setHistory)
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [patientReference, historyRefresh]);

  async function recordAxialLength() {
    const payloadEyes = Object.fromEntries(
      (["OD", "OS"] as const).flatMap((eye) => {
        const axialLengthMm = Number(eyes[eye].axialLength);
        if (!eyes[eye].axialLength.trim() || !Number.isFinite(axialLengthMm)) return [];
        const rawCornealRadius = eyes[eye].cornealRadius.trim();
        const cornealRadiusMm = rawCornealRadius ? Number(rawCornealRadius) : undefined;
        if (cornealRadiusMm !== undefined && !Number.isFinite(cornealRadiusMm)) return [];
        return [[eye, {
          axialLengthMm,
          ...(cornealRadiusMm !== undefined ? { cornealRadiusMm } : {}),
          biometryMethod,
          ...(instrument.trim() ? { instrument: instrument.trim() } : {}),
        }]];
      }),
    );
    if (Object.keys(payloadEyes).length === 0) {
      setError("Enter axial length for OD, OS, or both eyes.");
      return;
    }
    setBusy("axial");
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/eye-growth/axial-length`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          measuredAt: new Date().toISOString(),
          eyes: payloadEyes,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Axial length capture failed"));
      setEyes(EMPTY_EYES);
      setHistoryRefresh((value) => value + 1);
      markSaved(`${Object.keys(payloadEyes).join("/")} axial length recorded`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function saveReferencePopulation(referencePopulation: MyopiaReferencePopulation) {
    setBusy("population");
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/eye-growth/reference-population`, {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, referencePopulation }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Reference population save failed"));
      setHistory((current) => current ? { ...current, referencePopulation } : current);
      setHistoryRefresh((value) => value + 1);
      markSaved(`Reference population: ${populationLabel(referencePopulation)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  function markSaved(summary: string) {
    const next = {
      completed: false,
      summary,
      savedAt: new Date().toISOString(),
      operator: "ODOS UI eye_growth",
    };
    setStatus(next);
    onSaved(next);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Eye Growth</h2>
        <div className="mt-5 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">Axial Length</h3>
              <div className="mt-1 text-xs text-[color:var(--odos-muted)]">
                Decimal age is calculated from the measurement date and date of birth.
              </div>
            </div>
            <label className="text-xs text-[color:var(--odos-muted)]">
              Reference population
              <select
                value={history?.referencePopulation ?? "NOT_REPRESENTED"}
                onChange={(event) => void saveReferencePopulation(event.target.value as MyopiaReferencePopulation)}
                disabled={busy !== null}
                className="mt-1 block h-9 rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)] disabled:opacity-50"
              >
                <option value="ASIAN">Asian</option>
                <option value="CAUCASIAN">Caucasian</option>
                <option value="NOT_REPRESENTED">Not represented — no dataset available</option>
              </select>
            </label>
          </div>
          <div className="mt-4 grid gap-2 lg:grid-cols-[70px_1fr_1fr]">
            <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Eye</div>
            <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Axial length (mm)</div>
            <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Corneal radius (mm, optional)</div>
            {(["OD", "OS"] as const).map((eye) => (
              <div key={eye} className="contents">
                <div className="self-center text-sm font-semibold text-[color:var(--odos-text)]">{eye}</div>
                <input
                  type="number"
                  min="18"
                  max="32"
                  step="0.01"
                  value={eyes[eye].axialLength}
                  onChange={(event) => setEyes((current) => ({
                    ...current,
                    [eye]: { ...current[eye], axialLength: event.target.value },
                  }))}
                  aria-label={`${eye} axial length in millimeters`}
                  className="h-10 rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]"
                />
                <input
                  type="number"
                  min="5"
                  max="12"
                  step="0.01"
                  value={eyes[eye].cornealRadius}
                  onChange={(event) => setEyes((current) => ({
                    ...current,
                    [eye]: { ...current[eye], cornealRadius: event.target.value },
                  }))}
                  aria-label={`${eye} corneal radius in millimeters`}
                  className="h-10 rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-[color:var(--odos-muted)]">
              Biometry method
              <select
                value={biometryMethod}
                onChange={(event) => setBiometryMethod(event.target.value as typeof biometryMethod)}
                className="mt-1 block h-10 rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]"
              >
                <option value="OPTICAL_BIOMETRY">Optical biometry</option>
                <option value="ULTRASOUND_A_SCAN">Ultrasound A-scan</option>
              </select>
            </label>
            <label className="min-w-56 flex-1 text-xs text-[color:var(--odos-muted)]">
              Instrument (optional)
              <input
                value={instrument}
                onChange={(event) => setInstrument(event.target.value)}
                className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]"
              />
            </label>
            <button
              onClick={() => void recordAxialLength()}
              disabled={busy !== null}
              className="h-10 rounded border border-[color:var(--odos-accent-border)] bg-[var(--odos-accent-tint-hi)] px-4 text-sm font-semibold text-[color:var(--odos-text)] hover:bg-[var(--odos-accent-tint-lo)] disabled:opacity-50"
            >
              Record measurement
            </button>
          </div>
          <div className="mt-5">
            <AxialGrowthChart
              readings={history?.readings ?? []}
              referenceDataset={history?.referenceDataset ?? null}
              noReferenceMessage={history?.noReferenceMessage ?? null}
            />
          </div>
        </div>
        <div className="mt-5 min-h-10">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
          {status && !error && (
            <div className="text-sm text-[color:var(--odos-muted)]">
              {status.summary}
              <span className="ml-3 rounded border border-[color:var(--odos-line)] px-2 py-1 text-xs text-[color:var(--odos-muted)]">{status.operator} {status.savedAt}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function populationLabel(population: MyopiaReferencePopulation): string {
  if (population === "ASIAN") return "Asian";
  if (population === "CAUCASIAN") return "Caucasian";
  return "Not represented (no dataset available)";
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `${fallback}: ${response.status}`;
}
