import type { Patient } from "@medplum/fhirtypes";
import type { OrbitalId } from "../types/orbital";
import { ORBITAL_LABELS } from "../types/orbital";

interface Props {
  patient: Patient;
  selected: OrbitalId | null;
  onClearSelection: () => void;
}

export function Hud({ patient, selected, onClearSelection }: Props) {
  const name = patient.name?.[0];
  const display = name
    ? `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim()
    : "Unknown";

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      <header className="pointer-events-auto p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="text-sm tracking-widest text-white/40 uppercase">OSOD · Patient Director</div>
          <div className="h-4 w-px bg-white/20" />
          <div className="text-sm font-semibold">{display}</div>
          {patient.birthDate && (
            <div className="text-xs text-white/50">DOB {patient.birthDate}</div>
          )}
        </div>
        <div className="text-xs text-white/30">v0.2 — Variant A</div>
      </header>

      <div className="flex-1" />

      <footer className="pointer-events-auto p-4 text-xs text-white/40 flex justify-between">
        <div>
          {selected ? (
            <span>
              Focused: <span className="text-white/80">{ORBITAL_LABELS[selected]}</span>{" "}
              <button className="underline hover:text-white" onClick={onClearSelection}>
                clear
              </button>
            </span>
          ) : (
            "Hover an orbital · click to zoom · scroll to zoom view"
          )}
        </div>
        <div>Drag to rotate · scroll to zoom</div>
      </footer>
    </div>
  );
}
