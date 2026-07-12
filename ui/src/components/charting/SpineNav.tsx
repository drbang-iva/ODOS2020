import { sectionStatus, type BuiltInSectionId, type ChartSectionId, type SectionStatusMap } from "./types";

const SECTIONS: Array<{ id: BuiltInSectionId; label: string; readOnly?: boolean; group?: string; subHeader?: string }> = [
  { id: "wearing", label: "Wearing (WRx)", group: "PRETEST" },
  { id: "auto-refraction", label: "Auto-Refraction / Auto-K", group: "PRETEST" },
  { id: "va", label: "Visual Acuity", group: "PRETEST" },
  { id: "iop", label: "IOP", group: "PRETEST" },
  { id: "refraction", label: "Refraction", group: "REFRACTION" },
  { id: "refraction-history", label: "Refraction History", readOnly: true, group: "REFRACTION" },
  { id: "soft-contact-lens", label: "Soft Contact Lenses", group: "CONTACT LENSES" },
  { id: "specialty-contact-lens", label: "Specialty Contact Lens", group: "CONTACT LENSES" },
  { id: "ortho-k", label: "Ortho-K", group: "CONTACT LENSES" },
  { id: "myopia-management", label: "Myopia Management", group: "CONTACT LENSES" },
  { id: "cup-disc", label: "Cup/Disc", group: "OCULAR HEALTH", subHeader: "POSTERIOR SEGMENT" },
  { id: "dry-eye", label: "Dry Eye", group: "OCULAR HEALTH" },
  { id: "assessment", label: "Assessment", group: "ASSESSMENT & PLAN" },
  { id: "prescription", label: "Plan · Prescriptions", group: "ASSESSMENT & PLAN" },
];

interface Props {
  active: ChartSectionId;
  statuses: SectionStatusMap;
  onSelect: (section: ChartSectionId) => void;
  customSections?: Array<{ id: ChartSectionId; label: string }>;
  ocularHealthSections?: Array<{ id: ChartSectionId; label: string; segment?: "anterior" | "posterior" }>;
  onAddSection?: () => void;
}

export function SpineNav({ active, statuses, onSelect, customSections = [], ocularHealthSections = [], onAddSection }: Props) {
  const cupDiscIndex = SECTIONS.findIndex((section) => section.id === "cup-disc");
  const anterior = ocularHealthSections.filter((section) => section.segment !== "posterior");
  const posterior = ocularHealthSections.filter((section) => section.segment === "posterior");
  const sections: Array<{
    id: ChartSectionId;
    label: string;
    readOnly?: boolean;
    group?: string;
    subHeader?: string;
  }> = [
    ...SECTIONS.slice(0, cupDiscIndex),
    ...anterior.map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "ANTERIOR SEGMENT" })),
    ...posterior.slice(0, 1).map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "POSTERIOR SEGMENT" })),
    SECTIONS[cupDiscIndex]!,
    ...posterior.slice(1).map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "POSTERIOR SEGMENT" })),
    ...SECTIONS.slice(cupDiscIndex + 1),
    ...customSections,
  ];
  return (
    <nav className="shrink-0 border-b border-white/10 bg-bg-panel/70 p-3 md:w-60 md:border-b-0 md:border-r md:p-4">
      <div className="text-xs uppercase tracking-widest text-white/35">Spine</div>
      <div className="mt-3 flex gap-2 overflow-x-auto md:mt-4 md:block md:space-y-2 md:overflow-visible">
        {sections.map((section, index) => {
          const status = sectionStatus(statuses, section.id);
          const completed = status.completed;
          const focused = active === section.id;
          const readOnly = section.readOnly;
          const group = section.group;
          const previousSection = sections[index - 1];
          const previousGroup = previousSection?.group;
          const subHeader = section.subHeader;
          const previousSubHeader = previousSection?.subHeader;
          return (
            <div key={section.id} className="w-44 shrink-0 md:w-full">
              {group && group !== previousGroup && (
                <div className="mb-2 px-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35 md:pt-3">
                  {group}
                </div>
              )}
              {subHeader && subHeader !== previousSubHeader && (
                <div className="mb-2 border-l border-brand/40 px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-light">
                  {subHeader}
                </div>
              )}
              {!subHeader && previousSubHeader && group === previousGroup && <div className="mb-3 border-t border-white/10" />}
              <button
                onClick={() => onSelect(section.id)}
                className={[
                  "grid min-h-20 w-full grid-cols-[10px_1fr] gap-3 rounded border p-3 text-left transition",
                  focused ? "border-brand/70 bg-brand/15" : "border-white/10 bg-bg-mid/70 hover:border-white/25",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-1 h-3 w-3 rounded-full",
                    completed ? "bg-emerald-400" : readOnly ? "bg-brand/70" : "bg-white/25",
                  ].join(" ")}
                />
                <span>
                  <span className="block text-sm font-semibold text-white">{section.label}</span>
                  <span className="mt-1 block text-xs text-white/45">
                    {readOnly ? "Read only" : status.summary ?? (completed ? "Saved" : "Incomplete")}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
        {onAddSection && (
          <button
            type="button"
            onClick={onAddSection}
            className="min-h-12 w-44 shrink-0 rounded border border-dashed border-brand/45 px-3 py-2 text-left text-sm font-semibold text-brand-light transition hover:bg-brand/10 md:w-full"
          >
            + Add section
          </button>
        )}
      </div>
    </nav>
  );
}
