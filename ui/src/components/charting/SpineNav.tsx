import type { ChartSectionId, SectionStatusMap } from "./types";

const SECTIONS: Array<{ id: ChartSectionId; label: string }> = [
  { id: "va", label: "Visual Acuity" },
  { id: "iop", label: "IOP" },
  { id: "refraction", label: "Refraction" },
];

interface Props {
  active: ChartSectionId;
  statuses: SectionStatusMap;
  onSelect: (section: ChartSectionId) => void;
}

export function SpineNav({ active, statuses, onSelect }: Props) {
  return (
    <nav className="w-60 shrink-0 border-r border-white/10 bg-bg-panel/70 p-4">
      <div className="text-xs uppercase tracking-widest text-white/35">Spine</div>
      <div className="mt-4 space-y-2">
        {SECTIONS.map((section) => {
          const completed = statuses[section.id].completed;
          const focused = active === section.id;
          return (
            <button
              key={section.id}
              onClick={() => onSelect(section.id)}
              className={[
                "grid min-h-20 w-full grid-cols-[10px_1fr] gap-3 rounded border p-3 text-left transition",
                focused ? "border-brand/70 bg-brand/15" : "border-white/10 bg-bg-mid/70 hover:border-white/25",
              ].join(" ")}
            >
              <span
                className={[
                  "mt-1 h-3 w-3 rounded-full",
                  completed ? "bg-emerald-400" : "bg-white/25",
                ].join(" ")}
              />
              <span>
                <span className="block text-sm font-semibold text-white">{section.label}</span>
                <span className="mt-1 block text-xs text-white/45">
                  {completed ? statuses[section.id].summary ?? "Saved" : "Incomplete"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
