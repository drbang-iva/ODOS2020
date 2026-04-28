import { useEffect, useMemo, useState } from "react";
import type { CarePlan, EpisodeOfCare, MedicationStatement, Observation, Provenance } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { buildEpisodeOfCare } from "../../lib/fhir-clinical/episodeOfCare";
import {
  ATROPINE_CONCENTRATION_CODES,
  buildAtropineMedicationStatement,
  buildMyopiaAxialLengthObservation,
  buildMyopiaManagementCarePlan,
  buildUpdateMyopiaCarePlanPatch,
  carePlanInterventionReference,
  type AtropineConcentrationCode,
  type MyopiaControlInterventionCode,
  type MyopiaPlanActivityInput,
} from "../../lib/fhir-v04c/myopiaManagement";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

const EDUCATION_SNIPPETS = [
  "The plan works best when the family can keep the same routine most days.",
  "Bring any drops, lenses, or spectacles to follow-up so the plan can be reconciled.",
  "Axial length values are trended over time; the doctor decides how the plan changes.",
] as const;

export function MyopiaManagementSection({ patientReference, encounterReference, onSaved }: Props) {
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [episode, setEpisode] = useState<EpisodeOfCare | null>(null);
  const [carePlan, setCarePlan] = useState<CarePlan | null>(null);
  const [atropine, setAtropine] = useState<MedicationStatement | null>(null);
  const [concentration, setConcentration] = useState<AtropineConcentrationCode>("0.025%");
  const [frequency, setFrequency] = useState("1 drop OU qhs");
  const [axialLength, setAxialLength] = useState("24.12");
  const [eye, setEye] = useState<"OD" | "OS">("OD");
  const [measurements, setMeasurements] = useState<Observation[]>([]);
  const [snippet, setSnippet] = useState<string>(EDUCATION_SNIPPETS[0]);

  useEffect(() => {
    let cancelled = false;
    async function loadEpisode() {
      setBusy("load");
      try {
        const bundle = await fhir.search<EpisodeOfCare>("EpisodeOfCare", {
          patient: patientReference,
          _count: "20",
        });
        const activeMyopiaEpisode = (bundle.entry ?? [])
          .map((entry) => entry.resource)
          .find((resource): resource is EpisodeOfCare =>
            resource?.resourceType === "EpisodeOfCare" &&
            resource.status === "active" &&
            resource.type?.some((type) =>
              (type.coding ?? []).some((coding) => coding.code === "myopia-management"),
            ) === true,
          );
        if (!cancelled) setEpisode(activeMyopiaEpisode ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(null);
      }
    }
    void loadEpisode();
    return () => {
      cancelled = true;
    };
  }, [patientReference]);

  const progression = useMemo(() => {
    const points = measurements
      .map((observation) => ({
        value: observation.valueQuantity?.value,
        date: observation.effectiveDateTime,
      }))
      .filter((point): point is { value: number; date: string } =>
        typeof point.value === "number" && typeof point.date === "string",
      );
    if (points.length < 2) return undefined;
    const first = points[0];
    const last = points[points.length - 1];
    const years = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 24 * 60 * 60 * 1000);
    return years > 0 ? ((last.value - first.value) / years).toFixed(2) : undefined;
  }, [measurements]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function recordAxialLength() {
    setBusy("axial");
    setError(null);
    try {
      const observation = await fhir.create<Observation>(
        buildMyopiaAxialLengthObservation({
          patientReference,
          encounterReference,
          eye,
          measuredAt: new Date().toISOString(),
          valueMm: Number(axialLength),
        }),
        "record_myopia_axial_length_measurement",
      );
      await createUiProvenance("record_myopia_axial_length_measurement", [`Observation/${observation.id}`]);
      setMeasurements((current) => [...current, observation]);
      markSaved(`${eye} axial length ${axialLength} mm`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function markSaved(summary: string) {
    const next = {
      completed: true,
      summary,
      savedAt: new Date().toISOString(),
      operator: "OSOD UI myopia_management",
    };
    setStatus(next);
    onSaved(next);
  }

  if (!episode) {
    return (
      <section className="h-full overflow-y-auto p-6">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold text-white">Myopia Management</h2>
          <div className="mt-5 rounded border border-white/10 bg-bg-panel/70 p-4">
            <div className="text-sm text-white/70">
              {busy === "load" ? "Checking active episode..." : "No active myopia-management episode."}
            </div>
            <button onClick={startEpisode} disabled={busy !== null} className="mt-4 rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
              Start episode
            </button>
            {error && <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-white">Myopia Management</h2>
        <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_1fr]">
          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <h3 className="text-sm font-semibold text-white">Treatment Plan</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
              <label className="text-sm text-white/70">
                Atropine
                <select value={concentration} onChange={(event) => setConcentration(event.target.value as AtropineConcentrationCode)} className="mt-1 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand">
                  {ATROPINE_CONCENTRATION_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <label className="text-sm text-white/70">
                Frequency
                <input value={frequency} onChange={(event) => setFrequency(event.target.value)} className="mt-1 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand" />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={addAtropine} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                Add atropine
              </button>
              <button onClick={savePlan} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                Save plan
              </button>
            </div>
            <div className="mt-4 rounded border border-white/10 bg-bg-mid/60 p-3 text-sm text-white/70">
              {(carePlan?.activity ?? []).length
                ? carePlan?.activity?.map((activity, index) => (
                    <div key={index} className="py-1">
                      {activity.detail?.code?.text ?? "Intervention"} · {activity.detail?.status}
                      {carePlanInterventionReference(activity) ? ` · ${carePlanInterventionReference(activity)}` : ""}
                    </div>
                  ))
                : "No CarePlan activity saved yet."}
            </div>
          </div>

          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <h3 className="text-sm font-semibold text-white">Axial Length</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-[96px_1fr_auto]">
              <select value={eye} onChange={(event) => setEye(event.target.value as "OD" | "OS")} className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand">
                <option value="OD">OD</option>
                <option value="OS">OS</option>
              </select>
              <input value={axialLength} onChange={(event) => setAxialLength(event.target.value)} className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand" />
              <button onClick={recordAxialLength} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                Record
              </button>
            </div>
            <div className="mt-4 h-28 rounded border border-white/10 bg-bg-mid/60 p-3 text-sm text-white/70">
              {measurements.length ? measurements.map((observation) => (
                <div key={observation.id ?? observation.effectiveDateTime}>
                  {observation.bodySite?.coding?.[0]?.code} {observation.valueQuantity?.value} mm
                </div>
              )) : "No axial length values recorded this session."}
              {progression && <div className="mt-2 text-white">Slope {progression} mm/year</div>}
            </div>
          </div>

          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <h3 className="text-sm font-semibold text-white">Protocol Reference</h3>
            <div className="mt-3 grid gap-2 text-sm text-white/70">
              <div>6-8 · baseline refraction, keratometry, axial length, parent preference</div>
              <div>9-12 · compare active interventions and adherence burden</div>
              <div>13-17 · monitor progression, comfort, and treatment continuity</div>
            </div>
          </div>

          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <h3 className="text-sm font-semibold text-white">Parent Education</h3>
            <select value={snippet} onChange={(event) => setSnippet(event.target.value)} className="mt-3 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand">
              {EDUCATION_SNIPPETS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <div className="mt-3 rounded border border-white/10 bg-bg-mid/60 p-3 text-sm text-white/70">{snippet}</div>
          </div>
        </div>

        <div className="mt-5 min-h-10">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
          {status && !error && (
            <div className="text-sm text-white/70">
              {status.summary}
              <span className="ml-3 rounded border border-white/10 px-2 py-1 text-xs text-white/45">{status.operator} {status.savedAt}</span>
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

async function createUiProvenance(sourceTag: string, targetReferences: string[]): Promise<Provenance> {
  return fhir.create<Provenance>(
    {
      resourceType: "Provenance",
      target: targetReferences.map((reference) => ({ reference })),
      recorded: new Date().toISOString(),
      activity: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE", display: "Create" }],
      },
      agent: [{ who: { display: `OSOD UI ${sourceTag}` } }],
    },
    sourceTag,
  );
}
