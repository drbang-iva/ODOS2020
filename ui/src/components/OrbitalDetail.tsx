import { useEffect, useState } from "react";
import type { Observation, Patient } from "@medplum/fhirtypes";
import { fhir } from "../lib/fhir";
import type { OrbitalId } from "../types/orbital";
import { ORBITAL_LABELS } from "../types/orbital";

interface Props {
  orbitalId: OrbitalId;
  patient: Patient;
  onClose: () => void;
}

export function OrbitalDetail({ orbitalId, patient, onClose }: Props) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // v0.2 placeholder: fetch ALL Observations for the patient.
        // v0.3+: filter by anatomical-location extension once v0.1 POC
        //        starts tagging Observations with HL7 Eyecare IG codes.
        const b = await fhir.search<Observation>("Observation", {
          subject: `Patient/${patient.id}`,
          _count: "50",
        });
        if (!cancelled) {
          setObservations((b.entry ?? []).map((e) => e.resource!).filter(Boolean));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [orbitalId, patient.id]);

  return (
    <div className="absolute top-0 right-0 h-full w-96 bg-bg-panel/95 backdrop-blur border-l border-white/10 overflow-y-auto animate-slidein">
      <div className="p-4 border-b border-white/10 flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-white/40">Orbital</div>
          <h2 className="text-lg font-semibold">{ORBITAL_LABELS[orbitalId]}</h2>
        </div>
        <button
          onClick={onClose}
          className="text-white/40 hover:text-white transition text-sm"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="p-4 space-y-3">
        {loading && <div className="text-white/40 text-sm">Loading observations…</div>}
        {!loading && observations.length === 0 && (
          <div className="text-white/40 text-sm italic">
            No observations yet for this patient. v0.1 POC writes Observations without
            anatomical-location tags; add the tag in the next commit to drive this panel.
          </div>
        )}
        {observations.map((o) => (
          <div key={o.id} className="bg-bg-mid rounded p-3">
            <div className="text-xs text-white/40">{o.code?.text ?? o.code?.coding?.[0]?.display ?? "Observation"}</div>
            <div className="text-sm mt-1">
              {o.valueString ?? o.valueQuantity?.value?.toString() ?? o.valueCodeableConcept?.text ?? "—"}
              {o.valueQuantity?.unit && <span className="text-white/60"> {o.valueQuantity.unit}</span>}
            </div>
            {o.effectiveDateTime && (
              <div className="text-xs text-white/30 mt-1">{o.effectiveDateTime}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
