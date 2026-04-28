import { useMemo, useState } from "react";
import type {
  AdverseEvent,
  MedicationStatement,
  Observation,
  Procedure,
  Provenance,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
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
import {
  buildDryEyeQuestionnaireResponse,
  buildDryEyeQuestionnaireScoreObservation,
  computeDryEyeQuestionnaireScore,
  defaultDryEyeQuestionnaireAnswers,
  type DryEyeQuestionnaireAnswerInput,
} from "../../lib/fhir-dry-eye/questionnaireResponse";
import {
  DRY_EYE_QUESTIONNAIRE_INSTRUMENTS,
  type DryEyeQuestionnaireInstrument,
} from "../../lib/fhir-dry-eye/terminology";
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

export function DryEyeSection({ patientReference, encounterReference, onSaved }: Props) {
  const [instrument, setInstrument] = useState<DryEyeQuestionnaireInstrument>("OSDI");
  const [answers, setAnswers] = useState<DryEyeQuestionnaireAnswerInput[]>(
    defaultDryEyeQuestionnaireAnswers("OSDI"),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [series, setSeries] = useState<{ parent?: Procedure; session?: Procedure }>({});
  const [productText, setProductText] = useState<string>(PRODUCT_OPTIONS[0].text);
  const [adverseEventText, setAdverseEventText] = useState("");

  const score = useMemo(
    () => computeDryEyeQuestionnaireScore(instrument, answers),
    [answers, instrument],
  );

  function changeInstrument(next: DryEyeQuestionnaireInstrument) {
    setInstrument(next);
    setAnswers(defaultDryEyeQuestionnaireAnswers(next));
  }

  function updateAnswer(index: number, value: string) {
    const numeric = Number(value);
    setAnswers((current) =>
      current.map((answer, answerIndex) =>
        answerIndex === index
          ? { ...answer, valueInteger: Number.isFinite(numeric) ? numeric : 0 }
          : answer,
      ),
    );
  }

  async function saveQuestionnaire() {
    setBusy("questionnaire");
    setError(null);
    try {
      const authored = new Date().toISOString();
      const questionnaireResponse = await fhir.create<QuestionnaireResponse>(
        buildDryEyeQuestionnaireResponse({
          instrument,
          patientReference,
          encounterReference,
          authored,
          answers,
        }),
        "create_dry_eye_questionnaire_response",
      );
      const scoreObservation = await fhir.create<Observation>(
        buildDryEyeQuestionnaireScoreObservation({
          instrument,
          patientReference,
          encounterReference,
          questionnaireResponseReference: `QuestionnaireResponse/${questionnaireResponse.id}`,
          effectiveDateTime: authored,
          score,
          answers,
        }),
        "create_dry_eye_questionnaire_response",
      );
      await createUiProvenance("create_dry_eye_questionnaire_response", [
        `QuestionnaireResponse/${questionnaireResponse.id}`,
        `Observation/${scoreObservation.id}`,
      ]);
      markSaved(`${instrument} ${score}`);
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
      completed: true,
      summary,
      savedAt: new Date().toISOString(),
      operator: "OSOD UI dry_eye",
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">Questionnaire</h3>
              <select
                value={instrument}
                onChange={(event) => changeInstrument(event.target.value as DryEyeQuestionnaireInstrument)}
                className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
              >
                {DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {answers.map((answer, index) => (
                <label key={answer.linkId} className="grid grid-cols-[1fr_72px] items-center gap-2 rounded border border-white/10 bg-bg-mid/60 px-3 py-2 text-sm">
                  <span className="text-white/70">{answer.text ?? answer.linkId}</span>
                  <input
                    value={answer.valueInteger ?? 0}
                    onChange={(event) => updateAnswer(index, event.target.value)}
                    inputMode="numeric"
                    className="h-9 rounded border border-white/15 bg-bg-deep px-2 text-white outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-white/70">
                Score <span className="font-semibold text-white">{score}</span>
              </div>
              <button
                onClick={saveQuestionnaire}
                disabled={busy !== null}
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
                <select
                  value={productText}
                  onChange={(event) => setProductText(event.target.value)}
                  className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
                >
                  {PRODUCT_OPTIONS.map((option) => (
                    <option key={option.text} value={option.text}>{option.text}</option>
                  ))}
                </select>
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
          who: { display: `OSOD UI ${sourceTag}` },
        },
      ],
    },
    sourceTag,
  );
}
