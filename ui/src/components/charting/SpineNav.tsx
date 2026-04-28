import type { ChartSectionId, SectionStatusMap } from "./types";

const SECTIONS: Array<{ id: ChartSectionId; label: string }> = [
  { id: "va", label: "Visual Acuity" },
  { id: "refraction", label: "Refraction" },
  { id: "ortho-k", label: "Ortho-K" },
  { id: "dry-eye", label: "Dry Eye" },
  { id: "myopia-management", label: "Myopia Management" },
  { id: "iop", label: "IOP" },
  { id: "assessment", label: "Assessment" },
];

interface Props {
  active: ChartSectionId;
  statuses: SectionStatusMap;
  onSelect: (section: ChartSectionId) => void;
}

export function SpineNav({ active, statuses, onSelect }: Props) {
  return (
    <nav className="shrink-0 border-b border-white/10 bg-bg-panel/70 p-3 md:w-60 md:border-b-0 md:border-r md:p-4">
      <div className="text-xs uppercase tracking-widest text-white/35">Spine</div>
      <div className="mt-3 flex gap-2 overflow-x-auto md:mt-4 md:block md:space-y-2 md:overflow-visible">
        {SECTIONS.map((section) => {
          const completed = statuses[section.id].completed;
          const focused = active === section.id;
          return (
            <button
              key={section.id}
              onClick={() => onSelect(section.id)}
              className={[
                "grid min-h-20 w-44 shrink-0 grid-cols-[10px_1fr] gap-3 rounded border p-3 text-left transition md:w-full",
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
