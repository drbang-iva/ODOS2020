import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AllergyIntolerance,
  CareTeam,
  Condition,
  DeviceUseStatement,
  Encounter,
  EpisodeOfCare,
  MedicationStatement,
  Observation,
  Patient,
  PractitionerRole,
} from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import { cardDensity, type ChartCardId } from "../lib/card-registry";
import { useRole } from "../lib/role-context";
import {
  createAllergy,
  createCareTeam,
  createNoKnownAllergy,
  createProblemListCondition,
  createSmokingStatusObservation,
  promoteEncounterToProgram,
} from "../lib/clinical-actions";
import {
  allergyLabel,
  careTeamParticipantLabel,
  clinicalStatus,
  displayCode,
  episodeTypeLabel,
  isProblemListCondition,
  linkedEncounterCount,
  newestSmokingStatus,
  standaloneEncounters,
} from "../lib/clinical-view-model";
import { SMOKING_STATUS_CODES, smokingStatusAnswerConcept, type SmokingStatusCode } from "../lib/fhir-clinical/smokingStatus";
import { LongitudinalImagingCard } from "./LongitudinalImagingCard";
import { OdosSearchPicker } from "./inputs/OdosSearchPicker";
import { authHeaders, clinicalGraphApiBase } from "../lib/clinical-graph-client";

interface ChartData {
  allergies: AllergyIntolerance[];
  smokingObservations: Observation[];
  careTeams: CareTeam[];
  problemList: Condition[];
  episodes: EpisodeOfCare[];
  encounters: Encounter[];
  medications: MedicationStatement[];
  deviceUseStatements: DeviceUseStatement[];
}

type ChartReadResourceType =
  | "AllergyIntolerance"
  | "Observation"
  | "CareTeam"
  | "Condition"
  | "EpisodeOfCare"
  | "Encounter"
  | "MedicationStatement"
  | "DeviceUseStatement";

type ChartLoadFailures = Partial<Record<ChartReadResourceType, string>>;

const EMPTY_DATA: ChartData = {
  allergies: [],
  smokingObservations: [],
  careTeams: [],
  problemList: [],
  episodes: [],
  encounters: [],
  medications: [],
  deviceUseStatements: [],
};

export function ChartSidebar({ patient }: { patient: Patient }) {
  const { role } = useRole();
  const [data, setData] = useState<ChartData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [failures, setFailures] = useState<ChartLoadFailures>({});

  async function load() {
    if (!patient.id) return;
    setLoading(true);
    setFailures({});
    const patientReference = `Patient/${patient.id}`;
    const [
      allergyResult,
      observationResult,
      careTeamResult,
      conditionResult,
      episodeResult,
      encounterResult,
      medicationResult,
      deviceUseResult,
    ] = await Promise.allSettled([
      fhir.search<AllergyIntolerance>("AllergyIntolerance", { patient: patientReference, _count: "20" }),
      fhir.search<Observation>("Observation", { subject: patientReference, _count: "40", _sort: "-date" }),
      fhir.search<CareTeam>("CareTeam", { subject: patientReference, _count: "20" }),
      fhir.search<Condition>("Condition", { subject: patientReference, _count: "80" }),
      fhir.search<EpisodeOfCare>("EpisodeOfCare", { patient: patientReference, _count: "20" }),
      fhir.search<Encounter>("Encounter", { subject: patientReference, _count: "30", _sort: "-date" }),
      fhir.search<MedicationStatement>("MedicationStatement", { subject: patientReference, _count: "60" }),
      fhir.search<DeviceUseStatement>("DeviceUseStatement", { subject: patientReference, _count: "60" }),
    ]);
    const nextFailures: ChartLoadFailures = {};

    setData({
      allergies: settledResources("AllergyIntolerance", allergyResult, nextFailures),
      smokingObservations: settledResources("Observation", observationResult, nextFailures),
      careTeams: settledResources("CareTeam", careTeamResult, nextFailures),
      problemList: settledResources("Condition", conditionResult, nextFailures).filter(isProblemListCondition),
      episodes: settledResources("EpisodeOfCare", episodeResult, nextFailures)
        .filter((episode) => episode.status === "active"),
      encounters: settledResources("Encounter", encounterResult, nextFailures),
      medications: settledResources("MedicationStatement", medicationResult, nextFailures),
      deviceUseStatements: settledResources("DeviceUseStatement", deviceUseResult, nextFailures),
    });
    setFailures(nextFailures);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [patient.id]);

  const density = (cardId: ChartCardId) => cardDensity(cardId, role);

  return (
    <aside
      data-testid="chart-sidebar"
      className="pointer-events-auto relative z-20 flex h-[45vh] w-full shrink-0 flex-col border-t border-white/10 bg-bg-panel/90 text-white shadow-2xl lg:h-full lg:w-[360px] lg:border-l lg:border-t-0"
    >
      <div className="border-b border-white/10 p-4">
        <div className="text-xs uppercase tracking-widest text-white/35">Chart sidebar</div>
        <div className="mt-1 text-sm text-white/65">
          {loading
            ? "Loading chart context"
            : failures.Condition
              ? "Active chart lists unavailable"
              : `${data.problemList.length} active chart lists`}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {density("programs") !== "hidden" && (
          <ProgramsCard
            density={density("programs")}
            episodes={data.episodes}
            encounters={data.encounters}
            failures={failures}
            onChanged={load}
          />
        )}
        {density("allergies") !== "hidden" && (
          <AllergiesCard
            density={density("allergies")}
            patient={patient}
            allergies={data.allergies}
            failure={failures.AllergyIntolerance}
            onChanged={load}
          />
        )}
        {density("tobacco-use") !== "hidden" && (
          <TobaccoUseCard
            density={density("tobacco-use")}
            patient={patient}
            observations={data.smokingObservations}
            failure={failures.Observation}
            onChanged={load}
          />
        )}
        {density("product-timeline") !== "hidden" && (
          <ProductTimelineCard
            density={density("product-timeline")}
            medications={data.medications}
            deviceUseStatements={data.deviceUseStatements}
            failures={failures}
          />
        )}
        {density("care-team") !== "hidden" && (
          <CareTeamCard
            density={density("care-team")}
            patient={patient}
            careTeams={data.careTeams}
            failure={failures.CareTeam}
            onChanged={load}
          />
        )}
        {density("problem-list") !== "hidden" && (
          <ProblemListCard
            density={density("problem-list")}
            patient={patient}
            conditions={data.problemList}
            failure={failures.Condition}
            onChanged={load}
          />
        )}
        {density("longitudinal-imaging") !== "hidden" && patient.id && (
          <LongitudinalImagingCard patientReference={`Patient/${patient.id}`} />
        )}
      </div>
    </aside>
  );
}

function ProgramsCard({
  density,
  episodes,
  encounters,
  failures,
  onChanged,
}: {
  density: string;
  episodes: EpisodeOfCare[];
  encounters: Encounter[];
  failures: ChartLoadFailures;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const standalone = useMemo(() => standaloneEncounters(encounters).slice(0, 3), [encounters]);

  async function promote(encounter: Encounter, episode: EpisodeOfCare) {
    if (!episode.id) return;
    setBusy(encounter.id ?? "encounter");
    try {
      await promoteEncounterToProgram({
        encounter,
        episodeReference: `EpisodeOfCare/${episode.id}`,
      });
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <SidebarCard id="programs" title="Active Programs" density={density}>
      {failures.EpisodeOfCare && <ResourceReadFailure resourceType="EpisodeOfCare" message={failures.EpisodeOfCare} />}
      {failures.Encounter && <ResourceReadFailure resourceType="Encounter" message={failures.Encounter} />}
      {!failures.EpisodeOfCare && episodes.length === 0 ? (
        <EmptyLine>No active programs.</EmptyLine>
      ) : !failures.EpisodeOfCare && (
        <div className="space-y-2">
          {episodes.map((episode) => (
            <div key={episode.id} className="rounded border border-white/10 bg-bg-mid/60 p-2">
              <div className="text-sm font-semibold">{episodeTypeLabel(episode)}</div>
              <div className="text-xs text-white/45">
                {episode.status} · {failures.Encounter
                  ? "linked visits unavailable"
                  : `${linkedEncounterCount(episode, encounters)} linked visits`}
              </div>
            </div>
          ))}
        </div>
      )}

      {density === "full" && !failures.EpisodeOfCare && !failures.Encounter && episodes.length > 0 && standalone.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="text-xs uppercase tracking-widest text-white/35">Stand-alone visits</div>
          <div className="mt-2 space-y-2">
            {standalone.map((encounter) => (
              <button
                key={encounter.id}
                disabled={busy === encounter.id}
                onClick={() => promote(encounter, episodes[0])}
                className="w-full rounded border border-white/10 bg-bg-deep px-3 py-2 text-left text-xs text-white/70 transition hover:border-brand/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Attach {encounter.period?.start?.slice(0, 10) ?? encounter.id} to {episodeTypeLabel(episodes[0])}
              </button>
            ))}
          </div>
        </div>
      )}
    </SidebarCard>
  );
}

function AllergiesCard({
  density,
  patient,
  allergies,
  failure,
  onChanged,
}: {
  density: string;
  patient: Patient;
  allergies: AllergyIntolerance[];
  failure?: string;
  onChanged: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [display, setDisplay] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function addAllergy() {
    if (!patient.id || !code.trim()) return;
    setBusy("add");
    try {
      await createAllergy({
        patientReference: `Patient/${patient.id}`,
        code: {
          system: "http://www.nlm.nih.gov/research/umls/rxnorm",
          code: code.trim(),
          display: display.trim() || code.trim(),
        },
      });
      setCode("");
      setDisplay("");
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function markNka() {
    if (!patient.id) return;
    setBusy("nka");
    try {
      await createNoKnownAllergy(`Patient/${patient.id}`);
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <SidebarCard id="allergies" title="Allergies" density={density}>
      {failure ? (
        <ResourceReadFailure resourceType="AllergyIntolerance" message={failure} />
      ) : allergies.length === 0 ? (
        <EmptyLine>No allergies recorded.</EmptyLine>
      ) : (
        <List lines={allergies.map((allergy) => allergyLabel(allergy))} />
      )}
      {density === "full" && !failure && (
        <div className="mt-3 grid gap-2">
          <OdosSearchPicker
            label="Allergy / RxNorm"
            value={code}
            selectedLabel={display}
            placeholder="Search medication allergies"
            search={searchAllergyOptions}
            onClear={() => { setCode(""); setDisplay(""); }}
            onSelect={(option) => {
              setCode(option.item.code);
              setDisplay(option.item.display);
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <button disabled={busy !== null || !code.trim()} onClick={addAllergy} className="sidebar-button">
              Add allergy
            </button>
            <button disabled={busy !== null} onClick={markNka} className="sidebar-button">
              Mark no known allergies
            </button>
          </div>
        </div>
      )}
    </SidebarCard>
  );
}

function TobaccoUseCard({
  density,
  patient,
  observations,
  failure,
  onChanged,
}: {
  density: string;
  patient: Patient;
  observations: Observation[];
  failure?: string;
  onChanged: () => Promise<void>;
}) {
  const current = newestSmokingStatus(observations);
  const [statusCode, setStatusCode] = useState<SmokingStatusCode>("266919005");
  const [busy, setBusy] = useState(false);

  async function updateStatus() {
    if (!patient.id) return;
    setBusy(true);
    try {
      await createSmokingStatusObservation({
        patientReference: `Patient/${patient.id}`,
        statusCode,
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidebarCard id="tobacco-use" title="Tobacco Use" density={density}>
      {failure ? (
        <ResourceReadFailure resourceType="Observation" message={failure} />
      ) : <div className="text-sm text-white/80">
          {current ? displayCode(current.valueCodeableConcept) : "No tobacco use status recorded."}
        </div>}
      {!failure && current?.effectiveDateTime && (
        <div className="mt-1 text-xs text-white/40">{current.effectiveDateTime.slice(0, 10)}</div>
      )}
      {density === "full" && !failure && (
        <div className="mt-3 grid gap-2">
          <select value={statusCode} onChange={(event) => setStatusCode(event.target.value as SmokingStatusCode)} className="sidebar-input">
            {SMOKING_STATUS_CODES.map((value) => (
              <option key={value} value={value}>
                {displayCode(smokingStatusAnswerConcept(value))}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={updateStatus} className="sidebar-button">
            Update tobacco use
          </button>
        </div>
      )}
    </SidebarCard>
  );
}

function ProductTimelineCard({
  density,
  medications,
  deviceUseStatements,
  failures,
}: {
  density: string;
  medications: MedicationStatement[];
  deviceUseStatements: DeviceUseStatement[];
  failures: ChartLoadFailures;
}) {
  const groups = productTimelineGroups(medications, deviceUseStatements);

  return (
    <SidebarCard id="product-timeline" title="Product Timeline" density={density}>
      {failures.MedicationStatement && (
        <ResourceReadFailure resourceType="MedicationStatement" message={failures.MedicationStatement} />
      )}
      {failures.DeviceUseStatement && (
        <ResourceReadFailure resourceType="DeviceUseStatement" message={failures.DeviceUseStatement} />
      )}
      {groups.length === 0 && !failures.MedicationStatement && !failures.DeviceUseStatement ? (
        <EmptyLine>No products recorded.</EmptyLine>
      ) : groups.length > 0 && (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.indication} className="rounded border border-white/10 bg-bg-mid/60 p-2">
              <div className="text-xs uppercase tracking-widest text-white/35">{group.indication}</div>
              <div className="mt-2 space-y-2">
                {group.items.map((item) => (
                  <div key={item.key} className="text-sm text-white/75">
                    <span className="font-semibold text-white">{item.label}</span>
                    <span className="ml-2 text-xs text-white/45">{item.status}</span>
                    {density === "full" && item.date && (
                      <span className="ml-2 text-xs text-white/35">{item.date}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SidebarCard>
  );
}

function CareTeamCard({
  density,
  patient,
  careTeams,
  failure,
  onChanged,
}: {
  density: string;
  patient: Patient;
  careTeams: CareTeam[];
  failure?: string;
  onChanged: () => Promise<void>;
}) {
  const [roleText, setRoleText] = useState("Primary care physician");
  const [memberReference, setMemberReference] = useState("");
  const [memberLabel, setMemberLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = careTeams.flatMap((team) =>
    (team.participant ?? []).map((participant) => careTeamParticipantLabel(participant)),
  );

  async function addMember() {
    if (!patient.id || !memberReference.trim()) return;
    setBusy(true);
    try {
      await createCareTeam({
        patientReference: `Patient/${patient.id}`,
        roleText,
        memberReference: memberReference.trim(),
      });
      setMemberReference("");
      setMemberLabel("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidebarCard id="care-team" title="Care Team" density={density}>
      {failure
        ? <ResourceReadFailure resourceType="CareTeam" message={failure} />
        : lines.length === 0
          ? <EmptyLine>No care team recorded.</EmptyLine>
          : <List lines={lines} />}
      {density === "full" && !failure && (
        <div className="mt-3 grid gap-2">
          <select value={roleText} onChange={(event) => setRoleText(event.target.value)} className="sidebar-input">
            {["Primary care physician", "Ophthalmologist", "Endocrinologist", "Neurologist", "Caregiver"].map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <OdosSearchPicker
            label="Care-team member"
            value={memberReference}
            selectedLabel={memberLabel}
            placeholder="Search practitioner roles"
            search={searchPractitionerRoleOptions}
            onClear={() => { setMemberReference(""); setMemberLabel(""); }}
            onSelect={(option) => {
              setMemberReference(option.value);
              setMemberLabel(option.label);
            }}
          />
          <button disabled={busy || !memberReference.trim()} onClick={addMember} className="sidebar-button">
            Add team member
          </button>
        </div>
      )}
    </SidebarCard>
  );
}

function productTimelineGroups(
  medications: MedicationStatement[],
  deviceUseStatements: DeviceUseStatement[],
): Array<{
  indication: string;
  items: Array<{ key: string; label: string; status: string; date?: string }>;
}> {
  const byIndication = new Map<string, Array<{ key: string; label: string; status: string; date?: string }>>();
  for (const medication of medications) {
    const indication = medication.reasonCode?.[0]?.text ?? "Unspecified";
    const items = byIndication.get(indication) ?? [];
    items.push({
      key: `MedicationStatement/${medication.id ?? medication.medicationCodeableConcept?.text}`,
      label: displayCode(medication.medicationCodeableConcept),
      status: medication.status,
      date: medication.effectiveDateTime?.slice(0, 10) ?? medication.effectivePeriod?.start?.slice(0, 10),
    });
    byIndication.set(indication, items);
  }
  for (const statement of deviceUseStatements) {
    const indication = statement.reasonCode?.[0]?.text ?? "Unspecified";
    const items = byIndication.get(indication) ?? [];
    items.push({
      key: `DeviceUseStatement/${statement.id ?? statement.device.reference}`,
      label: statement.device.display ?? statement.device.reference ?? "Device",
      status: statement.status,
      date: statement.timingDateTime?.slice(0, 10) ?? statement.timingPeriod?.start?.slice(0, 10),
    });
    byIndication.set(indication, items);
  }
  return [...byIndication.entries()]
    .map(([indication, items]) => ({
      indication,
      items: items.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "")),
    }))
    .sort((left, right) => left.indication.localeCompare(right.indication));
}

function ProblemListCard({
  density,
  patient,
  conditions,
  failure,
  onChanged,
}: {
  density: string;
  patient: Patient;
  conditions: Condition[];
  failure?: string;
  onChanged: () => Promise<void>;
}) {
  const [display, setDisplay] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addProblem() {
    if (!patient.id || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createProblemListCondition({
        patientReference: `Patient/${patient.id}`,
        code: {
          system: "http://snomed.info/sct",
          code: code.trim(),
          display: display.trim() || code.trim(),
        },
        clinicalStatus: "active",
      });
      setCode("");
      setDisplay("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidebarCard id="problem-list" title="Problem List" density={density}>
      {failure ? (
        <ResourceReadFailure resourceType="Condition" message={failure} />
      ) : conditions.length === 0 ? (
        <EmptyLine>No active longitudinal problems.</EmptyLine>
      ) : (
        <div className="space-y-2">
          {conditions.map((condition) => (
            <div key={condition.id} className="rounded border border-white/10 bg-bg-mid/60 p-2">
              <div className="text-sm font-semibold">{displayCode(condition.code)}</div>
              <div className="text-xs text-white/45">
                {clinicalStatus(condition)}
                {condition.onsetDateTime ? ` · onset ${condition.onsetDateTime.slice(0, 10)}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
      {density === "full" && !failure && (
        <div className="mt-3 grid gap-2">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-100">{error}</div>}
          <OdosSearchPicker
            label="Problem / SNOMED"
            value={code}
            selectedLabel={display}
            placeholder="Search the diagnosis catalog"
            search={searchProblemOptions}
            onClear={() => { setCode(""); setDisplay(""); }}
            onSelect={(option) => {
              setCode(option.item.code);
              setDisplay(option.item.display);
            }}
          />
          <button disabled={busy || !code.trim()} onClick={addProblem} className="sidebar-button">
            Add problem
          </button>
        </div>
      )}
    </SidebarCard>
  );
}

interface ClinicalCodeOption {
  code: string;
  display: string;
}

async function searchAllergyOptions(query: string, signal: AbortSignal) {
  const results = await fhir.searchWenoFormulary(clinicalGraphApiBase(), query, signal);
  return results.map((result) => ({
    value: result.drugDbCode,
    label: result.psnDescription,
    description: [result.route, result.strength, result.drugDbCode].filter(Boolean).join(" · "),
    item: { code: result.drugDbCode, display: result.psnDescription } satisfies ClinicalCodeOption,
  }));
}

async function searchProblemOptions(query: string, signal: AbortSignal) {
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/diagnosis-catalog`, {
    headers: authHeaders(),
    signal,
  });
  const body = await response.json() as {
    diagnoses?: Array<{
      display: string;
      stableKey: string;
      active: boolean;
      codingStatus: "verified" | "placeholder" | "provisional";
      snomed?: ClinicalCodeOption;
    }>;
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? `Diagnosis catalog request failed: ${response.status}`);
  const normalized = query.trim().toLocaleLowerCase();
  return (body.diagnoses ?? [])
    .filter((row) =>
      row.active
      && row.codingStatus === "verified"
      && row.snomed
      && `${row.display} ${row.stableKey} ${row.snomed.code}`.toLocaleLowerCase().includes(normalized))
    .slice(0, 20)
    .map((row) => ({
      value: row.snomed!.code,
      label: row.snomed!.display,
      description: `${row.snomed!.code} · ${row.display}`,
      item: row.snomed!,
    }));
}

async function searchPractitionerRoleOptions(query: string) {
  const bundle = await fhir.search<PractitionerRole>("PractitionerRole", {
    "practitioner.name": query,
    active: "true",
    _count: "20",
  });
  return (bundle.entry ?? []).flatMap((entry) => {
    const role = entry.resource;
    if (!role?.id) return [];
    const label = role.practitioner?.display
      ?? role.specialty?.[0]?.text
      ?? role.code?.[0]?.text
      ?? `Practitioner role ${role.id}`;
    return [{
      value: `PractitionerRole/${role.id}`,
      label,
      description: [
        role.specialty?.[0]?.text,
        role.organization?.display,
        `PractitionerRole/${role.id}`,
      ].filter(Boolean).join(" · "),
      item: role,
    }];
  });
}

function SidebarCard({
  id,
  title,
  density,
  children,
}: {
  id: ChartCardId;
  title: string;
  density: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={`sidebar-card-${id}`} className="rounded border border-white/10 bg-bg-deep/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="rounded border border-white/10 px-2 py-1 text-[10px] uppercase tracking-widest text-white/35">
          {density}
        </span>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function List({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-2">
      {lines.map((line) => (
        <div key={line} className="rounded border border-white/10 bg-bg-mid/60 p-2 text-sm text-white/75">
          {line}
        </div>
      ))}
    </div>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="text-sm text-white/45">{children}</div>;
}

function ResourceReadFailure({
  resourceType,
  message,
}: {
  resourceType: ChartReadResourceType;
  message: string;
}) {
  return (
    <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-100">
      {resourceType} unavailable: {message}
    </div>
  );
}

function settledResources<T>(
  resourceType: ChartReadResourceType,
  result: PromiseSettledResult<{ entry?: Array<{ resource?: T }> }>,
  failures: ChartLoadFailures,
): T[] {
  if (result.status === "fulfilled") return resources(result.value);
  failures[resourceType] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return [];
}

function resources<T>(bundle: { entry?: Array<{ resource?: T }> }): T[] {
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : []));
}
