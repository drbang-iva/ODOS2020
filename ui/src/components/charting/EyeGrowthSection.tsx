import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  AxialGrowthChart,
  type AxialGrowthRate,
  type AxialGrowthReading,
  type AxialGrowthReferenceDataset,
  type MyopiaReferencePopulation,
} from "./AxialGrowthChart";
import { MethodField } from "../inputs/MethodField";
import { OdosWheel } from "../inputs/OdosWheel";
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
  growthRates?: AxialGrowthRate[];
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
  const [cornealRadiusErrors, setCornealRadiusErrors] = useState<Partial<Record<"OD" | "OS", string>>>({});
  const pendingCornealRadiusClamp = useRef<Partial<Record<"OD" | "OS", string>>>({});
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
    const axialLengthErrors: string[] = [];
    const nextCornealRadiusErrors: Partial<Record<"OD" | "OS", string>> = { ...cornealRadiusErrors };
    const payloadEyes = Object.fromEntries(
      (["OD", "OS"] as const).flatMap((eye) => {
        const rawAxialLength = eyes[eye].axialLength.trim();
        if (!rawAxialLength) return [];
        const axialLengthMm = Number(eyes[eye].axialLength);
        if (!Number.isFinite(axialLengthMm)) {
          axialLengthErrors.push(`Axial length for ${eye} is not a number.`);
          return [];
        }
        if (axialLengthMm < 18 || axialLengthMm > 32) {
          axialLengthErrors.push(`Axial length for ${eye} must be between 18 and 32 mm.`);
          return [];
        }
        const rawCornealRadius = eyes[eye].cornealRadius.trim();
        const cornealRadiusError = cornealRadiusWarning(rawCornealRadius, eye);
        const cornealRadiusMm = rawCornealRadius && !cornealRadiusError
          ? Number(rawCornealRadius)
          : undefined;
        if (rawCornealRadius && cornealRadiusError) nextCornealRadiusErrors[eye] = cornealRadiusError;
        return [[eye, {
          axialLengthMm,
          ...(cornealRadiusMm !== undefined ? { cornealRadiusMm } : {}),
          biometryMethod,
          ...(instrument.trim() ? { instrument: instrument.trim() } : {}),
        }]];
      }),
    );
    setCornealRadiusErrors(nextCornealRadiusErrors);
    if (axialLengthErrors.length > 0) {
      setError(axialLengthErrors.join(" "));
      return;
    }
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
      if (!response.ok) throw new Error(await responseError(response, "Reference curve save failed"));
      setHistory((current) => current ? { ...current, referencePopulation } : current);
      setHistoryRefresh((value) => value + 1);
      markSaved(`Reference curve: ${referenceCurveLabel(referencePopulation)}`);
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
          <div>
            <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">Axial Length</h3>
            <div className="mt-1 text-xs text-[color:var(--odos-muted)]">
              Decimal age is calculated from the measurement date and date of birth.
            </div>
          </div>
          <div className="mt-4">
            <MethodField
              label="Biometry method"
              renderValueControl={() => (
                <div className="grid gap-2 lg:grid-cols-[70px_1fr_1fr]">
                  <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Eye</div>
                  <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Axial length (mm)</div>
                  <div className="hidden text-xs font-medium uppercase tracking-wide text-[color:var(--odos-muted)] lg:block">Corneal radius (mm, optional)</div>
                  {(["OD", "OS"] as const).map((eye) => (
                    <div key={eye} className="contents">
                      <div className="self-center text-sm font-semibold text-[color:var(--odos-text)]">{eye}</div>
                      <OdosWheel
                        value={eyes[eye].axialLength === "" ? null : Number(eyes[eye].axialLength)}
                        centerOn={0}
                        min={18}
                        max={32}
                        step={0.01}
                        format={(value) => value.toFixed(2)}
                        onChange={(value) => setEyes((current) => ({
                          ...current,
                          [eye]: { ...current[eye], axialLength: value.toFixed(2) },
                        }))}
                        ariaLabel={`${eye} axial length in millimeters`}
                        unit="mm"
                        states={[{ value: "", label: "Not recorded" }]}
                        selectedState={eyes[eye].axialLength === "" ? "" : undefined}
                        onStateChange={() => setEyes((current) => ({
                          ...current,
                          [eye]: { ...current[eye], axialLength: "" },
                        }))}
                      />
                      <div
                        data-corneal-radius-eye={eye}
                        onBlurCapture={(event) => {
                          const rawValue = (event.target as { value?: unknown }).value;
                          if (typeof rawValue !== "string") return;
                          const warning = cornealRadiusWarning(rawValue, eye);
                          const numericValue = Number(rawValue.trim());
                          const wasClamped = Number.isFinite(numericValue) && (numericValue < 5 || numericValue > 12);
                          if (wasClamped) {
                            pendingCornealRadiusClamp.current[eye] = rawValue;
                            queueMicrotask(() => {
                              if (pendingCornealRadiusClamp.current[eye] === rawValue) {
                                delete pendingCornealRadiusClamp.current[eye];
                              }
                            });
                          } else {
                            delete pendingCornealRadiusClamp.current[eye];
                          }
                          if (warning) {
                            setCornealRadiusErrors((current) => ({ ...current, [eye]: warning }));
                          } else {
                            setCornealRadiusErrors((current) => ({ ...current, [eye]: undefined }));
                          }
                        }}
                      >
                        <OdosWheel
                          value={eyes[eye].cornealRadius === "" ? null : Number(eyes[eye].cornealRadius)}
                          centerOn={0}
                          min={5}
                          max={12}
                          step={0.01}
                          format={(value) => value.toFixed(2)}
                          onChange={(value) => {
                            const preserveClampWarning = pendingCornealRadiusClamp.current[eye] !== undefined;
                            delete pendingCornealRadiusClamp.current[eye];
                            setEyes((current) => ({
                              ...current,
                              [eye]: { ...current[eye], cornealRadius: value.toFixed(2) },
                            }));
                            if (!preserveClampWarning) {
                              setCornealRadiusErrors((current) => ({ ...current, [eye]: undefined }));
                            }
                          }}
                          ariaLabel={`${eye} corneal radius in millimeters`}
                          ariaInvalid={cornealRadiusErrors[eye] ? true : undefined}
                          ariaDescribedBy={cornealRadiusErrors[eye] ? `eye-growth-corneal-radius-${eye}-error` : undefined}
                          unit="mm"
                          states={[{ value: "", label: "Not recorded" }]}
                          selectedState={eyes[eye].cornealRadius === "" ? "" : undefined}
                          onStateChange={() => {
                            delete pendingCornealRadiusClamp.current[eye];
                            setEyes((current) => ({
                              ...current,
                              [eye]: { ...current[eye], cornealRadius: "" },
                            }));
                            setCornealRadiusErrors((current) => ({ ...current, [eye]: undefined }));
                          }}
                        />
                        {cornealRadiusErrors[eye] && (
                          <div
                            id={`eye-growth-corneal-radius-${eye}-error`}
                            aria-live="polite"
                            role="status"
                            className="mt-1 text-xs text-amber-200"
                          >
                            {cornealRadiusErrors[eye]}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              methodValue={biometryMethod}
              methodOptions={[
                { value: "OPTICAL_BIOMETRY", label: "Optical biometry" },
                { value: "ULTRASOUND_A_SCAN", label: "Ultrasound A-scan" },
              ]}
              onMethodChange={(method) => setBiometryMethod(method as typeof biometryMethod)}
              methodAriaLabel="Biometry method"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
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
            <MethodField
              label="Reference curve"
              renderValueControl={() => (
                <AxialGrowthChart
                  readings={history?.readings ?? []}
                  growthRates={history?.growthRates ?? []}
                  referenceDataset={history?.referenceDataset ?? null}
                  noReferenceMessage={history?.noReferenceMessage ?? null}
                />
              )}
              methodValue={history?.referencePopulation ?? "CAUCASIAN"}
              methodOptions={[
                { value: "CAUCASIAN", label: "European (default)" },
                { value: "ASIAN", label: "Asian" },
              ]}
              onMethodChange={(referencePopulation) => void saveReferencePopulation(referencePopulation as MyopiaReferencePopulation)}
              methodAriaLabel="Reference curve"
              disabled={busy !== null}
            />
            <span id="eye-growth-reference-curve-help" className="mt-1 block text-xs leading-4 text-[color:var(--odos-muted)]">
              Select a published comparison curve. This does not record patient demographics.
            </span>
          </div>
        </div>
        <div id="eye-growth-status-message" aria-live="polite" className="mt-5 min-h-10">
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

function referenceCurveLabel(population: MyopiaReferencePopulation): string {
  if (population === "ASIAN") return "Asian";
  return "European (default)";
}

function cornealRadiusWarning(rawValue: string, eye: "OD" | "OS"): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return `Corneal radius for ${eye} was cleared because it is not a number.`;
  }
  if (value < 5 || value > 12) {
    const adjustedValue = Math.min(12, Math.max(5, value));
    return `Corneal radius for ${eye} was adjusted to ${adjustedValue.toFixed(2)} mm (valid range 5-12 mm).`;
  }
  return undefined;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `${fallback}: ${response.status}`;
}
