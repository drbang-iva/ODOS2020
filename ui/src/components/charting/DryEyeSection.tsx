import { useEffect, useState } from "react";
import type {
  AdverseEvent,
  MedicationStatement,
  Procedure,
  Provenance,
} from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  buildDryEyeAdverseEvent,
} from "../../lib/fhir-dry-eye/adverseEvent";
import {
  buildOphthalmicMedicationStatement,
  type OphthalmicSupplyTypeCode,
} from "../../lib/fhir-dry-eye/ophthalmicMedicationStatement";
import {
  buildDryEyeTreatmentProcedure,
  buildDryEyeTreatmentSeriesProcedure,
} from "../../lib/fhir-dry-eye/procedure";
import { OdosSelect } from "../inputs/OdosSelect";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

const PRODUCT_OPTIONS = [
  { text: "Artificial tears", supplyType: "otc" },
  { text: "Restasis", supplyType: "rx" },
  { text: "Cequa", supplyType: "rx" },
  { text: "Xiidra", supplyType: "rx" },
  { text: "Doxycycline", supplyType: "rx" },
  { text: "Omega-3", supplyType: "supplement" },
] as const;

const SYMPTOM_INSTRUMENTS = ["OSDI", "SPEED", "DEQ-5"] as const;
type SymptomInstrument = (typeof SYMPTOM_INSTRUMENTS)[number];

interface QuestionnaireDraft {
  totalScore: string;
  dateAdministered: string;
  unableToTest: boolean;
}

interface QuestionnaireHistoryRow {
  values: Array<{ code: string; value: number | string }>;
}

const EMPTY_DRAFT: QuestionnaireDraft = {
  totalScore: "",
  dateAdministered: "",
  unableToTest: false,
};

function emptyQuestionnaireDrafts(): Record<SymptomInstrument, QuestionnaireDraft> {
  return Object.fromEntries(
    SYMPTOM_INSTRUMENTS.map((value) => [value, { ...EMPTY_DRAFT }]),
  ) as Record<SymptomInstrument, QuestionnaireDraft>;
}

export function DryEyeSection({ patientReference, encounterReference, onSaved }: Props) {
  const [instrument, setInstrument] = useState<SymptomInstrument>("OSDI");
  const [questionnaireDrafts, setQuestionnaireDrafts] = useState(emptyQuestionnaireDrafts);
  const [questionnaireLoading, setQuestionnaireLoading] = useState(true);
  const [instrumentSwitchNotice, setInstrumentSwitchNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [series, setSeries] = useState<{ parent?: Procedure; session?: Procedure }>({});
  const [productText, setProductText] = useState<string>(PRODUCT_OPTIONS[0].text);
  const [adverseEventText, setAdverseEventText] = useState("");
  const questionnaireDraft = questionnaireDrafts[instrument];

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    setInstrument("OSDI");
    setQuestionnaireDrafts(emptyQuestionnaireDrafts());
    setInstrumentSwitchNotice(null);
    setQuestionnaireLoading(true);
    fetch(
      `${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent("dry-eye:symptoms")}/history?${query}`,
      { headers: authHeaders(), signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json() as { rows?: QuestionnaireHistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `Dry-eye questionnaire history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then((rows) => {
        const savedRows = rows
          .map(questionnaireDraftFromHistory)
          .filter((row): row is { instrument: SymptomInstrument; draft: QuestionnaireDraft } => row !== undefined);
        const newest = savedRows[0];
        if (!newest) return;
        setInstrument(newest.instrument);
        setQuestionnaireDrafts((current) => {
          const next = { ...current };
          for (const saved of [...savedRows].reverse()) next[saved.instrument] = saved.draft;
          return next;
        });
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuestionnaireLoading(false);
      });
    return () => controller.abort();
  }, [encounterReference, patientReference]);

  function updateQuestionnaireDraft(update: Partial<QuestionnaireDraft>) {
    setQuestionnaireDrafts((current) => ({
      ...current,
      [instrument]: { ...current[instrument], ...update },
    }));
  }

  function changeInstrument(next: SymptomInstrument) {
    if (next === instrument) return;
    setInstrumentSwitchNotice(
      questionnaireDraft.totalScore || questionnaireDraft.dateAdministered || questionnaireDraft.unableToTest
        ? `${instrument} entry retained separately; its score was not applied to ${next}.`
        : null,
    );
    setInstrument(next);
  }

  async function saveQuestionnaire() {
    setBusy("questionnaire");
    setError(null);
    try {
      const customFields: Array<{ code: string; value: number | string }> = [
        { code: "CUSTOM_INSTRUMENT", value: instrument },
      ];
      if (questionnaireDraft.totalScore.trim()) {
        const totalScore = Number(questionnaireDraft.totalScore);
        if (!Number.isFinite(totalScore) || totalScore < 0) {
          throw new Error("Total score must be a number of zero or more.");
        }
        customFields.push({ code: "CUSTOM_TOTAL_SCORE", value: totalScore });
      }
      if (questionnaireDraft.dateAdministered) {
        customFields.push({ code: "CUSTOM_DATE_ADMINISTERED", value: questionnaireDraft.dateAdministered });
      }
      if (questionnaireDraft.unableToTest) {
        customFields.push({ code: "CUSTOM_UNABLE_TO_TEST", value: "unable" });
      }
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent("dry-eye:symptoms")}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ patientReference, encounterReference, customFields }),
        },
      );
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Dry-eye questionnaire save failed: ${response.status}`);
      setInstrumentSwitchNotice(null);
      markSaved(
        questionnaireDraft.totalScore
          ? `${instrument} ${questionnaireDraft.totalScore}`
          : `${instrument} unable to test`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveIplSeries() {
    setBusy("series");
    setError(null);
    try {
      const now = new Date().toISOString();
      const parent = await fhir.create<Procedure>(
        buildDryEyeTreatmentSeriesProcedure({
          patientReference,
          encounterReference,
          treatmentType: "IPL",
          totalSessions: 4,
          seriesStartDateTime: now,
          reasonText: "Dry eye",
          parameters: { energyMj: 14, wavelengthNm: 590, spotCount: 42 },
        }),
        "create_dry_eye_treatment_series",
      );
      const session = await fhir.create<Procedure>(
        buildDryEyeTreatmentProcedure({
          patientReference,
          encounterReference,
          treatmentType: "IPL",
          status: "in-progress",
          seriesProcedureReference: `Procedure/${parent.id}`,
          performedDateTime: now,
          reasonText: "Dry eye",
          sessionNumber: 1,
          totalSessions: 4,
          parameters: { energyMj: 14, wavelengthNm: 590, spotCount: 42 },
        }),
        "create_dry_eye_treatment_series",
      );
      await createUiProvenance("create_dry_eye_treatment_series", [
        `Procedure/${parent.id}`,
        `Procedure/${session.id}`,
      ]);
      setSeries({ parent, session });
      markSaved("IPL 1/4");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function addProduct() {
    const option = PRODUCT_OPTIONS.find((item) => item.text === productText) ?? PRODUCT_OPTIONS[0];
    setBusy("product");
    setError(null);
    try {
      const medicationStatement = await fhir.create<MedicationStatement>(
        buildOphthalmicMedicationStatement({
          patientReference,
          encounterReference,
          medication: { text: option.text },
          supplyType: option.supplyType as OphthalmicSupplyTypeCode,
          indicationText: "Dry eye",
          dosageText: option.supplyType === "supplement" ? "By mouth" : "Ophthalmic use",
          effectiveDateTime: new Date().toISOString(),
        }),
        "create_ophthalmic_medication_statement",
      );
      await createUiProvenance("create_ophthalmic_medication_statement", [
        `MedicationStatement/${medicationStatement.id}`,
      ]);
      markSaved(`${option.text} active`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function addAdverseEvent() {
    if (!adverseEventText.trim()) return;
    setBusy("adverse-event");
    setError(null);
    try {
      const adverseEvent = await fhir.create<AdverseEvent>(
        buildDryEyeAdverseEvent({
          patientReference,
          encounterReference,
          event: { text: adverseEventText.trim() },
          actuality: "actual",
          date: new Date().toISOString(),
          suspectEntityReferences: series.session?.id ? [`Procedure/${series.session.id}`] : undefined,
        }),
        "create_dry_eye_adverse_event",
      );
      await createUiProvenance("create_dry_eye_adverse_event", [
        `AdverseEvent/${adverseEvent.id}`,
      ]);
      setAdverseEventText("");
      markSaved("Adverse event captured");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function markSaved(summary: string) {
    const next = {
      completed: false,
      summary,
      savedAt: new Date().toISOString(),
      operator: "ODOS UI dry_eye",
    };
    setStatus(next);
    onSaved(next);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <h2 className="text-lg font-semibold text-white">Dry Eye</h2>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">Questionnaire</h3>
              <div>
                <div className="mb-1 text-xs uppercase tracking-widest text-white/35">Instrument</div>
                <OdosSelect
                  value={instrument}
                  options={SYMPTOM_INSTRUMENTS.map((value) => ({ value, label: value }))}
                  onChange={changeInstrument}
                  ariaLabel="Questionnaire instrument"
                  disabled={questionnaireLoading}
                />
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Total score</span>
                <input
                  aria-label="Total score"
                  type="number"
                  min={0}
                  step="any"
                  value={questionnaireDraft.totalScore}
                  onChange={(event) => updateQuestionnaireDraft({ totalScore: event.target.value })}
                  inputMode="decimal"
                  className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Date administered</span>
                <input
                  aria-label="Date administered"
                  type="date"
                  value={questionnaireDraft.dateAdministered}
                  onChange={(event) => updateQuestionnaireDraft({ dateAdministered: event.target.value })}
                  className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Unable to test</span>
                <span className="flex h-11 items-center gap-3 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white/70">
                  <input
                    aria-label="Unable to test"
                    type="checkbox"
                    checked={questionnaireDraft.unableToTest}
                    onChange={(event) => updateQuestionnaireDraft({ unableToTest: event.target.checked })}
                    className="accent-brand"
                  />
                  {questionnaireDraft.unableToTest ? "Yes" : "No"}
                </span>
              </label>
            </div>

            {instrumentSwitchNotice && (
              <div role="status" className="mt-3 text-sm text-amber-100">
                {instrumentSwitchNotice}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
              <button
                onClick={saveQuestionnaire}
                disabled={
                  busy !== null ||
                  questionnaireLoading ||
                  (!questionnaireDraft.totalScore.trim() && !questionnaireDraft.unableToTest)
                }
                className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "questionnaire" ? "Saving..." : "Save questionnaire"}
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Treatment Series</h3>
              <div className="mt-3 rounded border border-white/10 bg-bg-mid/60 p-3 text-sm text-white/75">
                {series.session ? "IPL session 1/4 in progress" : "No active IPL series in this encounter."}
              </div>
              <button
                onClick={saveIplSeries}
                disabled={busy !== null}
                className="mt-3 w-full rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "series" ? "Saving..." : "Start IPL 1/4"}
              </button>
            </div>

            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Product</h3>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <OdosSelect
                  value={productText}
                  options={PRODUCT_OPTIONS.map((option) => ({ value: option.text, label: option.text }))}
                  onChange={setProductText}
                  ariaLabel="Product"
                />
                <button
                  onClick={addProduct}
                  disabled={busy !== null}
                  className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>

            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Adverse Event</h3>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <input
                  value={adverseEventText}
                  onChange={(event) => setAdverseEventText(event.target.value)}
                  placeholder="Event"
                  className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
                />
                <button
                  onClick={addAdverseEvent}
                  disabled={busy !== null || !adverseEventText.trim()}
                  className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Capture
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 min-h-10">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
          {status && !error && (
            <div className="text-sm text-white/70">
              {status.summary}
              <span className="ml-3 rounded border border-white/10 px-2 py-1 text-xs text-white/45">
                {status.operator} {status.savedAt}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function questionnaireDraftFromHistory(row: QuestionnaireHistoryRow): {
  instrument: SymptomInstrument;
  draft: QuestionnaireDraft;
} | undefined {
  const valueByCode = new Map(row.values.map((value) => [value.code, value.value]));
  const instrument = valueByCode.get("CUSTOM_INSTRUMENT");
  if (typeof instrument !== "string" || !SYMPTOM_INSTRUMENTS.includes(instrument as SymptomInstrument)) {
    return undefined;
  }
  const totalScore = valueByCode.get("CUSTOM_TOTAL_SCORE");
  const dateAdministered = valueByCode.get("CUSTOM_DATE_ADMINISTERED");
  return {
    instrument: instrument as SymptomInstrument,
    draft: {
      totalScore: typeof totalScore === "number" || typeof totalScore === "string" ? String(totalScore) : "",
      dateAdministered: typeof dateAdministered === "string" ? dateAdministered : "",
      unableToTest: valueByCode.get("CUSTOM_UNABLE_TO_TEST") === "unable",
    },
  };
}

async function createUiProvenance(sourceTag: string, targetReferences: string[]): Promise<Provenance> {
  return fhir.create<Provenance>(
    {
      resourceType: "Provenance",
      target: targetReferences.map((reference) => ({ reference })),
      recorded: new Date().toISOString(),
      activity: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
            code: "CREATE",
            display: "Create",
          },
        ],
      },
      agent: [
        {
          type: {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
                code: "author",
                display: "Author",
              },
            ],
          },
          who: { display: `ODOS UI ${sourceTag}` },
        },
      ],
    },
    sourceTag,
  );
}
