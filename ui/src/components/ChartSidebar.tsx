import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AllergyIntolerance,
  CareTeam,
  Condition,
  Encounter,
  EpisodeOfCare,
  Observation,
  Patient,
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

interface ChartData {
  allergies: AllergyIntolerance[];
  smokingObservations: Observation[];
  careTeams: CareTeam[];
  problemList: Condition[];
  episodes: EpisodeOfCare[];
  encounters: Encounter[];
}

const EMPTY_DATA: ChartData = {
  allergies: [],
  smokingObservations: [],
  careTeams: [],
  problemList: [],
  episodes: [],
  encounters: [],
};

export function ChartSidebar({ patient }: { patient: Patient }) {
  const { role } = useRole();
  const [data, setData] = useState<ChartData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!patient.id) return;
    setLoading(true);
    setError(null);
    try {
      const patientReference = `Patient/${patient.id}`;
      const [
        allergyBundle,
        observationBundle,
        careTeamBundle,
        conditionBundle,
        episodeBundle,
        encounterBundle,
      ] = await Promise.all([
        fhir.search<AllergyIntolerance>("AllergyIntolerance", { patient: patientReference, _count: "20" }),
        fhir.search<Observation>("Observation", { subject: patientReference, _count: "40", _sort: "-date" }),
        fhir.search<CareTeam>("CareTeam", { subject: patientReference, _count: "20" }),
        fhir.search<Condition>("Condition", { subject: patientReference, _count: "80" }),
        fhir.search<EpisodeOfCare>("EpisodeOfCare", { patient: patientReference, _count: "20" }),
        fhir.search<Encounter>("Encounter", { subject: patientReference, _count: "30", _sort: "-date" }),
      ]);

      setData({
        allergies: resources(allergyBundle),
        smokingObservations: resources(observationBundle),
        careTeams: resources(careTeamBundle),
        problemList: resources(conditionBundle).filter(isProblemListCondition),
        episodes: resources(episodeBundle).filter((episode) => episode.status === "active"),
        encounters: resources(encounterBundle),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
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
          {loading ? "Loading chart context" : `${data.problemList.length} active chart lists`}
        </div>
        {error && <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-100">{error}</div>}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {density("programs") !== "hidden" && (
          <ProgramsCard
            density={density("programs")}
            episodes={data.episodes}
            encounters={data.encounters}
            onChanged={load}
          />
        )}
        {density("allergies") !== "hidden" && (
          <AllergiesCard
            density={density("allergies")}
            patient={patient}
            allergies={data.allergies}
            onChanged={load}
          />
        )}
        {density("tobacco-use") !== "hidden" && (
          <TobaccoUseCard
            density={density("tobacco-use")}
            patient={patient}
            observations={data.smokingObservations}
            onChanged={load}
          />
        )}
        {density("care-team") !== "hidden" && (
          <CareTeamCard
            density={density("care-team")}
            patient={patient}
            careTeams={data.careTeams}
            onChanged={load}
          />
        )}
        {density("problem-list") !== "hidden" && (
          <ProblemListCard
            density={density("problem-list")}
            patient={patient}
            conditions={data.problemList}
            onChanged={load}
          />
        )}
      </div>
    </aside>
  );
}

function ProgramsCard({
  density,
  episodes,
  encounters,
  onChanged,
}: {
  density: string;
  episodes: EpisodeOfCare[];
  encounters: Encounter[];
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
      {episodes.length === 0 ? (
        <EmptyLine>No active programs.</EmptyLine>
      ) : (
        <div className="space-y-2">
          {episodes.map((episode) => (
            <div key={episode.id} className="rounded border border-white/10 bg-bg-mid/60 p-2">
              <div className="text-sm font-semibold">{episodeTypeLabel(episode)}</div>
              <div className="text-xs text-white/45">
                {episode.status} · {linkedEncounterCount(episode, encounters)} linked visits
              </div>
            </div>
          ))}
        </div>
      )}

      {density === "full" && episodes.length > 0 && standalone.length > 0 && (
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
  onChanged,
}: {
  density: string;
  patient: Patient;
  allergies: AllergyIntolerance[];
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
      {allergies.length === 0 ? (
        <EmptyLine>No allergies recorded.</EmptyLine>
      ) : (
        <List lines={allergies.map((allergy) => allergyLabel(allergy))} />
      )}
      {density === "full" && (
        <div className="mt-3 grid gap-2">
          <input value={display} onChange={(event) => setDisplay(event.target.value)} placeholder="Allergy name" className="sidebar-input" />
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="RxNorm code" className="sidebar-input" />
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
  onChanged,
}: {
  density: string;
  patient: Patient;
  observations: Observation[];
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
      <div className="text-sm text-white/80">
        {current ? displayCode(current.valueCodeableConcept) : "No tobacco use status recorded."}
      </div>
      {current?.effectiveDateTime && (
        <div className="mt-1 text-xs text-white/40">{current.effectiveDateTime.slice(0, 10)}</div>
      )}
      {density === "full" && (
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

function CareTeamCard({
  density,
  patient,
  careTeams,
  onChanged,
}: {
  density: string;
  patient: Patient;
  careTeams: CareTeam[];
  onChanged: () => Promise<void>;
}) {
  const [roleText, setRoleText] = useState("Primary care physician");
  const [memberReference, setMemberReference] = useState("");
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
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidebarCard id="care-team" title="Care Team" density={density}>
      {lines.length === 0 ? <EmptyLine>No care team recorded.</EmptyLine> : <List lines={lines} />}
      {density === "full" && (
        <div className="mt-3 grid gap-2">
          <select value={roleText} onChange={(event) => setRoleText(event.target.value)} className="sidebar-input">
            {["Primary care physician", "Ophthalmologist", "Endocrinologist", "Neurologist", "Caregiver"].map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <input value={memberReference} onChange={(event) => setMemberReference(event.target.value)} placeholder="PractitionerRole/<id>" className="sidebar-input" />
          <button disabled={busy || !memberReference.trim()} onClick={addMember} className="sidebar-button">
            Add team member
          </button>
        </div>
      )}
    </SidebarCard>
  );
}

function ProblemListCard({
  density,
  patient,
  conditions,
  onChanged,
}: {
  density: string;
  patient: Patient;
  conditions: Condition[];
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
      {conditions.length === 0 ? (
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
      {density === "full" && (
        <div className="mt-3 grid gap-2">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-100">{error}</div>}
          <input value={display} onChange={(event) => setDisplay(event.target.value)} placeholder="Problem" className="sidebar-input" />
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="SNOMED code" className="sidebar-input" />
          <button disabled={busy || !code.trim()} onClick={addProblem} className="sidebar-button">
            Add problem
          </button>
        </div>
      )}
    </SidebarCard>
  );
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

function resources<T>(bundle: { entry?: Array<{ resource?: T }> }): T[] {
  return (bundle.entry ?? []).flatMap((entry) => (entry.resource ? [entry.resource] : []));
}
