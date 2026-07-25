import { useEffect, useState } from "react";
import type { CarePlan, EpisodeOfCare, MedicationStatement, Provenance } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { buildEpisodeOfCare } from "../../lib/fhir-clinical/episodeOfCare";
import {
  ATROPINE_CONCENTRATION_CODES,
  buildAtropineMedicationStatement,
  buildMyopiaManagementCarePlan,
  buildUpdateMyopiaCarePlanPatch,
  carePlanInterventionReference,
  type AtropineConcentrationCode,
  type MyopiaControlInterventionCode,
  type MyopiaPlanActivityInput,
} from "../../lib/fhir-v04c/myopiaManagement";
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

interface ProgressionHistory {
  referencePopulation: MyopiaReferencePopulation;
  patientSex: "MALE" | "FEMALE" | null;
  birthDate: string;
  readings: AxialGrowthReading[];
  referenceDataset: AxialGrowthReferenceDataset | null;
  noReferenceMessage: string | null;
}

const EDUCATION_SNIPPETS = [
  "The plan works best when the family can keep the same routine most days.",
  "Bring any drops, lenses, or spectacles to follow-up so the plan can be reconciled.",
  "Axial length values are trended over time; the doctor decides how the plan changes.",
] as const;

const EMPTY_EYES: Record<"OD" | "OS", EyeInput> = {
  OD: { axialLength: "", cornealRadius: "" },
  OS: { axialLength: "", cornealRadius: "" },
};

export function MyopiaManagementSection({ patientReference, encounterReference, onSaved }: Props) {
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [episode, setEpisode] = useState<EpisodeOfCare | null>(null);
  const [carePlan, setCarePlan] = useState<CarePlan | null>(null);
  const [atropine, setAtropine] = useState<MedicationStatement | null>(null);
  const [concentration, setConcentration] = useState<AtropineConcentrationCode>("0.025%");
  const [frequency, setFrequency] = useState("1 drop OU qhs");
  const [eyes, setEyes] = useState<Record<"OD" | "OS", EyeInput>>(EMPTY_EYES);
  const [biometryMethod, setBiometryMethod] = useState<"OPTICAL_BIOMETRY" | "ULTRASOUND_A_SCAN">("OPTICAL_BIOMETRY");
  const [instrument, setInstrument] = useState("");
  const [history, setHistory] = useState<ProgressionHistory | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [snippet, setSnippet] = useState<string>(EDUCATION_SNIPPETS[0]);

  useEffect(() => {
    const controller = new AbortController();
    setBusy("load");
    setError(null);
    Promise.all([
      fhir.search<EpisodeOfCare>("EpisodeOfCare", { patient: patientReference, _count: "20" }),
      fetch(
        `${clinicalGraphApiBase()}/clinical-graph/myopia/history?${new URLSearchParams({ patient: patientReference })}`,
        { headers: authHeaders(), signal: controller.signal },
      ).then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response, "Myopia progression request failed"));
        return response.json() as Promise<ProgressionHistory>;
      }),
    ])
      .then(([bundle, progression]) => {
        const activeEpisode = (bundle.entry ?? [])
          .map((entry) => entry.resource)
          .find((resource): resource is EpisodeOfCare =>
            resource?.resourceType === "EpisodeOfCare" &&
            resource.status === "active" &&
            resource.type?.some((type) =>
              type.coding?.some((coding) => coding.code === "myopia-management"),
            ) === true,
          );
        setEpisode(activeEpisode ?? null);
        setHistory(progression);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [patientReference, historyRefresh]);

  async function startEpisode() {
    setBusy("episode");
    setError(null);
    try {
      const created = await fhir.create<EpisodeOfCare>(
        buildEpisodeOfCare({
          patientReference,
          typeCode: "myopia-management",
          status: "active",
          periodStart: new Date().toISOString(),
        }),
        "create_myopia_management_episode",
      );
      await createUiProvenance("create_myopia_management_episode", [`EpisodeOfCare/${created.id}`]);
      setEpisode(created);
      markSaved("Myopia episode started");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function recordAxialLength() {
    const payloadEyes = Object.fromEntries(
      (["OD", "OS"] as const).flatMap((eye) => {
        const axialLengthMm = Number(eyes[eye].axialLength);
        if (!eyes[eye].axialLength.trim() || !Number.isFinite(axialLengthMm)) return [];
        const cornealRadiusMm = eyes[eye].cornealRadius.trim()
          ? Number(eyes[eye].cornealRadius)
          : undefined;
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
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/myopia/axial-length`, {
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
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/myopia/reference-population`, {
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

  async function addAtropine() {
    if (!episode?.id) return;
    setBusy("atropine");
    setError(null);
    try {
      const created = await fhir.create<MedicationStatement>(
        buildAtropineMedicationStatement({
          patientReference,
          episodeOfCareReference: `EpisodeOfCare/${episode.id}`,
          encounterReference,
          concentration,
          frequencyText: frequency,
          effectiveDateTime: new Date().toISOString(),
        }),
        "create_atropine_medication_statement",
      );
      await createUiProvenance("create_atropine_medication_statement", [`MedicationStatement/${created.id}`]);
      setAtropine(created);
      markSaved(`Atropine ${concentration}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function savePlan() {
    if (!episode?.id) return;
    setBusy("plan");
    setError(null);
    try {
      const activities: MyopiaPlanActivityInput[] = [
        {
          interventionCode: "ortho-K",
          status: "in-progress",
          description: "Ortho-K intervention coordinated through the separate Ortho-K module.",
        },
        {
          interventionCode: interventionForConcentration(concentration),
          status: atropine ? "in-progress" : "scheduled",
          resourceReference: atropine?.id ? `MedicationStatement/${atropine.id}` : undefined,
          description: frequency,
        },
      ];
      if (carePlan?.id) {
        const updated = await fhir.patch<CarePlan>(
          "CarePlan",
          carePlan.id,
          buildUpdateMyopiaCarePlanPatch(carePlan, activities, "active"),
          "create_or_update_myopia_plan",
          carePlan.meta?.versionId,
        );
        await createUiProvenance("create_or_update_myopia_plan", [`CarePlan/${updated.id}`]);
        setCarePlan(updated);
      } else {
        const created = await fhir.create<CarePlan>(
          buildMyopiaManagementCarePlan({
            patientReference,
            episodeOfCareReference: `EpisodeOfCare/${episode.id}`,
            encounterReference,
            activities,
            noteText: snippet,
          }),
          "create_or_update_myopia_plan",
        );
        await createUiProvenance("create_or_update_myopia_plan", [`CarePlan/${created.id}`]);
        setCarePlan(created);
      }
      markSaved("CarePlan updated");
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
      operator: "ODOS UI myopia_progression",
    };
    setStatus(next);
    onSaved(next);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Myopia Progression</h2>

        <div className="mt-5 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">Axial Growth</h3>
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
                <option value="CAUCASIAN">Caucasian — no dataset available</option>
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

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
            <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">Treatment Plan</h3>
            {!episode ? (
              <div className="mt-3">
                <div className="text-sm text-[color:var(--odos-muted)]">
                  {busy === "load" ? "Checking active episode..." : "No active myopia-management episode."}
                </div>
                <button
                  onClick={() => void startEpisode()}
                  disabled={busy !== null}
                  className="mt-3 rounded border border-[color:var(--odos-accent-border)] bg-[var(--odos-accent-tint-hi)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-text)] hover:bg-[var(--odos-accent-tint-lo)] disabled:opacity-50"
                >
                  Start episode
                </button>
              </div>
            ) : (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
                  <label className="text-sm text-[color:var(--odos-muted)]">
                    Atropine
                    <select value={concentration} onChange={(event) => setConcentration(event.target.value as AtropineConcentrationCode)} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]">
                      {ATROPINE_CONCENTRATION_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </label>
                  <label className="text-sm text-[color:var(--odos-muted)]">
                    Frequency
                    <input value={frequency} onChange={(event) => setFrequency(event.target.value)} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]" />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => void addAtropine()} disabled={busy !== null} className="rounded border border-[color:var(--odos-accent-border)] bg-[var(--odos-accent-tint-hi)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-text)] hover:bg-[var(--odos-accent-tint-lo)] disabled:opacity-50">
                    Add atropine
                  </button>
                  <button onClick={() => void savePlan()} disabled={busy !== null} className="rounded border border-[color:var(--odos-accent-border)] bg-[var(--odos-accent-tint-hi)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-text)] hover:bg-[var(--odos-accent-tint-lo)] disabled:opacity-50">
                    Save plan
                  </button>
                </div>
                <div className="mt-4 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-muted)]">
                  {(carePlan?.activity ?? []).length
                    ? carePlan?.activity?.map((activity, index) => (
                        <div key={index} className="py-1">
                          {activity.detail?.code?.text ?? "Intervention"} · {activity.detail?.status}
                          {carePlanInterventionReference(activity) ? ` · ${carePlanInterventionReference(activity)}` : ""}
                        </div>
                      ))
                    : "No CarePlan activity saved yet."}
                </div>
              </>
            )}
          </div>

          <div className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
            <h3 className="text-sm font-semibold text-[color:var(--odos-text)]">Parent Education</h3>
            <select value={snippet} onChange={(event) => setSnippet(event.target.value)} className="mt-3 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-[var(--odos-deep-surface)] px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-[color:var(--odos-accent-border)]">
              {EDUCATION_SNIPPETS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <div className="mt-3 rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface-2)] p-3 text-sm text-[color:var(--odos-muted)]">{snippet}</div>
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

function interventionForConcentration(concentration: AtropineConcentrationCode): MyopiaControlInterventionCode {
  if (concentration === "0.01%") return "atropine-low-dose";
  if (concentration === "0.1%") return "atropine-high-dose";
  return "atropine-medium-dose";
}

function populationLabel(population: MyopiaReferencePopulation): string {
  if (population === "ASIAN") return "Asian";
  if (population === "CAUCASIAN") return "Caucasian (no dataset available)";
  return "Not represented (no dataset available)";
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `${fallback}: ${response.status}`;
}

async function createUiProvenance(sourceTag: string, targetReferences: string[]): Promise<Provenance> {
  return fhir.create<Provenance>(
    {
      resourceType: "Provenance",
      target: targetReferences.map((reference) => ({ reference })),
      recorded: new Date().toISOString(),
      activity: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE", display: "Create" }],
      },
      agent: [{ who: { display: `ODOS UI ${sourceTag}` } }],
    },
    sourceTag,
  );
}
