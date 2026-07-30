import { useEffect, useState } from "react";
import type { CarePlan, EpisodeOfCare, MedicationStatement, Provenance } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { buildEpisodeOfCare } from "../../lib/fhir-clinical/episodeOfCare";
import {
  ATROPINE_CONCENTRATION_CODES,
  MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL,
  buildAtropineMedicationStatement,
  buildMyopiaManagementCarePlan,
  buildUpdateMyopiaCarePlanPatch,
  carePlanInterventionReference,
  type AtropineConcentrationCode,
  type MyopiaControlInterventionCode,
  type MyopiaPlanActivityInput,
} from "../../lib/fhir-v04c/myopiaManagement";
import type { SectionSaveStatus } from "./types";
import { OdosSelect } from "../inputs/OdosSelect";

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
const DEFAULT_ATROPINE_FREQUENCY = "1 drop OU qhs";

export function MyopiaManagementSection({ patientReference, encounterReference, onSaved }: Props) {
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [episode, setEpisode] = useState<EpisodeOfCare | null>(null);
  const [carePlan, setCarePlan] = useState<CarePlan | null>(null);
  const [atropine, setAtropine] = useState<MedicationStatement | null>(null);
  const [concentration, setConcentration] = useState<AtropineConcentrationCode>("0.025%");
  const [frequency, setFrequency] = useState(DEFAULT_ATROPINE_FREQUENCY);
  const [snippet, setSnippet] = useState<string>(EDUCATION_SNIPPETS[0]);

  useEffect(() => {
    let cancelled = false;
    setBusy("load");
    setError(null);
    Promise.all([
      fhir.search<EpisodeOfCare>("EpisodeOfCare", { patient: patientReference, _count: "20" }),
      fhir.search<CarePlan>("CarePlan", { patient: patientReference, status: "active", _count: "20" }),
      fhir.search<MedicationStatement>("MedicationStatement", {
        patient: patientReference,
        status: "active",
        _count: "50",
      }),
    ])
      .then(([episodeBundle, carePlanBundle, medicationBundle]) => {
        if (cancelled) return;
        const activeEpisode = (episodeBundle.entry ?? [])
          .map((entry) => entry.resource)
          .find((resource): resource is EpisodeOfCare =>
            resource?.resourceType === "EpisodeOfCare" &&
            resource.status === "active" &&
            resource.type?.some((type) =>
              type.coding?.some((coding) => coding.code === "myopia-management"),
            ) === true,
          );
        const activeCarePlan = latestResource(
          (carePlanBundle.entry ?? [])
            .map((entry) => entry.resource)
            .filter((resource): resource is CarePlan =>
              resource?.resourceType === "CarePlan" &&
              resource.meta?.profile?.includes(MYOPIA_MANAGEMENT_CAREPLAN_PROFILE_URL) === true),
        );
        const activeAtropine = latestResource(
          (medicationBundle.entry ?? [])
            .map((entry) => entry.resource)
            .filter((resource): resource is MedicationStatement =>
              resource?.resourceType === "MedicationStatement" &&
              resource.medicationCodeableConcept?.coding?.some((coding) =>
                coding.system === "http://www.nlm.nih.gov/research/umls/rxnorm" &&
                coding.code === "1223") === true),
        );
        setEpisode(activeEpisode ?? null);
        setCarePlan(activeCarePlan ?? null);
        setAtropine(activeAtropine ?? null);
        const savedConcentration = activeAtropine?.dosage?.[0]?.doseAndRate?.[0]?.doseQuantity?.code;
        if (
          savedConcentration &&
          (ATROPINE_CONCENTRATION_CODES as readonly string[]).includes(savedConcentration)
        ) {
          setConcentration(savedConcentration as AtropineConcentrationCode);
        }
        if (activeAtropine?.dosage?.[0]?.text) setFrequency(activeAtropine.dosage[0].text);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [patientReference]);

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
      operator: "ODOS UI myopia_management",
    };
    setStatus(next);
    onSaved(next);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Myopia Management</h2>
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
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
                  <div className="text-sm text-[color:var(--odos-muted)]">
                    <div className="mb-1">Atropine</div>
                    <OdosSelect
                      ariaLabel="Atropine concentration"
                      value={concentration}
                      defaultValue="0.025%"
                      options={ATROPINE_CONCENTRATION_CODES.map((code) => ({ value: code, label: code }))}
                      onChange={setConcentration}
                    />
                  </div>
                  <div className="text-sm text-[color:var(--odos-muted)]">
                    <div className="mb-1">Frequency</div>
                    <OdosSelect
                      ariaLabel="Atropine frequency"
                      value={frequency}
                      defaultValue={DEFAULT_ATROPINE_FREQUENCY}
                      options={[...new Set([DEFAULT_ATROPINE_FREQUENCY, frequency])].map((value) => ({ value, label: value }))}
                      onChange={setFrequency}
                      onInputChange={setFrequency}
                      parseInput={(input) => input}
                      serializeValue={(value) => value}
                    />
                  </div>
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
            <div className="mt-3">
              <OdosSelect
                ariaLabel="Parent education snippet"
                value={snippet}
                defaultValue={EDUCATION_SNIPPETS[0]}
                options={EDUCATION_SNIPPETS.map((value) => ({ value, label: value }))}
                onChange={setSnippet}
              />
            </div>
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

function latestResource<T extends CarePlan | MedicationStatement>(resources: T[]): T | undefined {
  return resources.sort((left, right) =>
    resourceTimestamp(right) - resourceTimestamp(left))[0];
}

function resourceTimestamp(resource: CarePlan | MedicationStatement): number {
  const timestamp = resource.meta?.lastUpdated ??
    (resource.resourceType === "CarePlan"
      ? resource.created
      : resource.effectiveDateTime ?? resource.dateAsserted);
  const millis = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(millis) ? millis : 0;
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
