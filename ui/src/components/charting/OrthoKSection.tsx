import { useState } from "react";
import type { AdverseEvent, Device, Observation, Procedure, Provenance } from "@medplum/fhirtypes";
import { fhir } from "../../lib/fhir";
import {
  buildOrthoKFitObservation,
  buildOrthoKFittingEvent,
  buildOrthoKLensDevice,
  buildOrthoKTrialProcedure,
  buildUpdateOrthoKLensParametersPatch,
  type OrthoKFitFindingCode,
} from "../../lib/fhir-v04c/orthoK";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

const FIT_FINDINGS: OrthoKFitFindingCode[] = [
  "centration",
  "lens-decentration",
  "corneal-molding-response",
  "fluorescein-pattern",
  "edge-clearance",
  "comfort",
];

export function OrthoKSection({ patientReference, encounterReference, onSaved }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionSaveStatus | null>(null);
  const [lens, setLens] = useState<Device | null>(null);
  const [series, setSeries] = useState<Procedure | null>(null);
  const [trialCount, setTrialCount] = useState(0);
  const [finding, setFinding] = useState<OrthoKFitFindingCode>("centration");
  const [findingText, setFindingText] = useState("well-centered");
  const [adverseEventText, setAdverseEventText] = useState("");
  const [parameters, setParameters] = useState({
    baseCurveMm: "7.80",
    reverseCurveDepthUm: "550",
    alignmentCurveMm: "8.30",
    ozdMm: "6.20",
    diameterMm: "10.60",
    spherePower: "-2.00",
  });

  async function ensureLens(): Promise<Device> {
    if (lens) return lens;
    const created = await fhir.create<Device>(
      buildOrthoKLensDevice({
        patientReference,
        deviceName: "Ortho-K trial lens",
        manufacturer: "Paragon / Wave",
        properties: lensProperties(),
      }),
      "create_ortho_k_lens_device",
    );
    await createUiProvenance("create_ortho_k_lens_device", [`Device/${created.id}`]);
    setLens(created);
    return created;
  }

  async function saveLens() {
    setBusy("lens");
    setError(null);
    try {
      if (lens?.id) {
        const updated = await fhir.patch<Device>(
          "Device",
          lens.id,
          buildUpdateOrthoKLensParametersPatch(lens, lensProperties()),
          "update_ortho_k_lens_parameters",
          lens.meta?.versionId,
        );
        await createUiProvenance("update_ortho_k_lens_parameters", [`Device/${updated.id}`]);
        setLens(updated);
        markSaved("Ortho-K lens updated");
      } else {
        await ensureLens();
        markSaved("Ortho-K lens created");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startFittingTrail() {
    setBusy("series");
    setError(null);
    try {
      const device = await ensureLens();
      const created = await fhir.create<Procedure>(
        buildOrthoKFittingEvent({
          patientReference,
          encounterReference,
          lensDeviceReference: `Device/${device.id}`,
          eventCode: "initial-fit",
          status: "in-progress",
          performedDateTime: new Date().toISOString(),
          noteText: "Ortho-K fitting trail parent",
        }),
        "record_ortho_k_fitting_event",
      );
      await createUiProvenance("record_ortho_k_fitting_event", [`Procedure/${created.id}`]);
      setSeries(created);
      markSaved("Fitting trail started");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function recordTrial() {
    setBusy("trial");
    setError(null);
    try {
      const device = await ensureLens();
      const parent = series ?? await createSeries(device);
      const nextTrial = trialCount + 1;
      const created = await fhir.create<Procedure>(
        buildOrthoKTrialProcedure({
          patientReference,
          encounterReference,
          lensDeviceReference: `Device/${device.id}`,
          seriesProcedureReference: `Procedure/${parent.id}`,
          trialNumber: nextTrial,
          performedDateTime: new Date().toISOString(),
          parameterChangeSummary: "Parameters captured on Device.property",
          outcomeText: "Trial retained for comparison",
        }),
        "record_ortho_k_trial",
      );
      await createUiProvenance("record_ortho_k_trial", [`Procedure/${created.id}`]);
      setTrialCount(nextTrial);
      markSaved(`Trial ${nextTrial}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function recordFitFinding() {
    setBusy("finding");
    setError(null);
    try {
      const device = await ensureLens();
      const created = await fhir.create<Observation>(
        buildOrthoKFitObservation({
          patientReference,
          encounterReference,
          lensDeviceReference: `Device/${device.id}`,
          findingCode: finding,
          effectiveDateTime: new Date().toISOString(),
          valueCode: findingText.trim() || undefined,
          valueDisplay: findingText.trim() || undefined,
        }),
        "record_ortho_k_fit_observation",
      );
      await createUiProvenance("record_ortho_k_fit_observation", [`Observation/${created.id}`]);
      markSaved(`Fit finding: ${finding}`);
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
        {
          resourceType: "AdverseEvent",
          actuality: "actual",
          category: [{ text: "Ortho-K adverse event" }],
          event: { text: adverseEventText.trim() },
          subject: { reference: patientReference },
          encounter: { reference: encounterReference },
          recordedDate: new Date().toISOString(),
          ...(lens?.id ? { suspectEntity: [{ instance: { reference: `Device/${lens.id}` } }] } : {}),
        },
        "record_ortho_k_fitting_event",
      );
      await createUiProvenance("record_ortho_k_fitting_event", [`AdverseEvent/${adverseEvent.id}`]);
      setAdverseEventText("");
      markSaved("Adverse event captured");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function createSeries(device: Device): Promise<Procedure> {
    const created = await fhir.create<Procedure>(
      buildOrthoKFittingEvent({
        patientReference,
        encounterReference,
        lensDeviceReference: `Device/${device.id}`,
        eventCode: "initial-fit",
        status: "in-progress",
        performedDateTime: new Date().toISOString(),
        noteText: "Ortho-K fitting trail parent",
      }),
      "record_ortho_k_fitting_event",
    );
    await createUiProvenance("record_ortho_k_fitting_event", [`Procedure/${created.id}`]);
    setSeries(created);
    return created;
  }

  function lensProperties() {
    return [
      { code: "base-curve-mm", valueNumber: Number(parameters.baseCurveMm), unitCode: "mm" as const },
      { code: "reverse-curve-depth-um", valueNumber: Number(parameters.reverseCurveDepthUm), unitCode: "um" as const },
      { code: "alignment-curve-mm", valueNumber: Number(parameters.alignmentCurveMm), unitCode: "mm" as const },
      { code: "optic-zone-diameter-mm", valueNumber: Number(parameters.ozdMm), unitCode: "mm" as const },
      { code: "diameter-mm", valueNumber: Number(parameters.diameterMm), unitCode: "mm" as const },
      { code: "sphere-power", valueNumber: Number(parameters.spherePower), unitCode: "[diop]" as const },
    ];
  }

  function updateParameter(key: keyof typeof parameters, value: string) {
    setParameters((current) => ({ ...current, [key]: value }));
  }

  function markSaved(summary: string) {
    const next = {
      completed: true,
      summary,
      savedAt: new Date().toISOString(),
      operator: "OSOD UI ortho_k",
    };
    setStatus(next);
    onSaved(next);
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-5xl">
        <h2 className="text-lg font-semibold text-white">Ortho-K</h2>
        <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white">Lens Parameters</h3>
              <button onClick={saveLens} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                {busy === "lens" ? "Saving..." : lens ? "Update lens" : "Create lens"}
              </button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["baseCurveMm", "BC mm"],
                ["reverseCurveDepthUm", "RCD um"],
                ["alignmentCurveMm", "AC mm"],
                ["ozdMm", "OZD mm"],
                ["diameterMm", "Diameter mm"],
                ["spherePower", "Rx D"],
              ].map(([key, label]) => (
                <label key={key} className="text-sm text-white/70">
                  {label}
                  <input
                    value={parameters[key as keyof typeof parameters]}
                    onChange={(event) => updateParameter(key as keyof typeof parameters, event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Fitting Trail</h3>
              <div className="mt-3 rounded border border-white/10 bg-bg-mid/60 p-3 text-sm text-white/75">
                {series ? `Trail active, ${trialCount} trial${trialCount === 1 ? "" : "s"}` : "No active fitting trail."}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={startFittingTrail} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-3 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                  Start trail
                </button>
                <button onClick={recordTrial} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-3 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                  Trial
                </button>
              </div>
            </div>

            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Fit Finding</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <select value={finding} onChange={(event) => setFinding(event.target.value as OrthoKFitFindingCode)} className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand">
                  {FIT_FINDINGS.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
                <input value={findingText} onChange={(event) => setFindingText(event.target.value)} className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand" />
                <button onClick={recordFitFinding} disabled={busy !== null} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
                  Record
                </button>
              </div>
            </div>

            <div className="rounded border border-white/10 bg-bg-panel/70 p-4">
              <h3 className="text-sm font-semibold text-white">Adverse Event</h3>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <input value={adverseEventText} onChange={(event) => setAdverseEventText(event.target.value)} placeholder="Event" className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand" />
                <button onClick={addAdverseEvent} disabled={busy !== null || !adverseEventText.trim()} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white hover:bg-brand/25 disabled:opacity-50">
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
              <span className="ml-3 rounded border border-white/10 px-2 py-1 text-xs text-white/45">{status.operator} {status.savedAt}</span>
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
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: "CREATE", display: "Create" }],
      },
      agent: [{ who: { display: `OSOD UI ${sourceTag}` } }],
    },
    sourceTag,
  );
}
