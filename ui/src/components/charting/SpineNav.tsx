import { useEffect, useState } from "react";
import { sectionStatus, type ChartSectionId, type SectionStatusMap } from "./types";

interface SpineSection {
  id: ChartSectionId;
  label: string;
  readOnly?: boolean;
  group?: string;
  subHeader?: string;
}

const SECTIONS: SpineSection[] = [
  { id: "hpi", label: "Chief Complaint / HPI / ROS", group: "HISTORY" },
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
  { id: "imaging", label: "Manual imaging", group: "IMAGING" },
  { id: "assessment", label: "Assessment", group: "ASSESSMENT & PLAN" },
  { id: "prescription", label: "Plan · Prescriptions", group: "ASSESSMENT & PLAN" },
];

interface Props {
  active: ChartSectionId;
  statuses: SectionStatusMap;
  onSelect: (section: ChartSectionId) => void;
  customSections?: Array<{ id: ChartSectionId; label: string; group?: string }>;
  ocularHealthSections?: Array<{ id: ChartSectionId; label: string; segment?: "anterior" | "posterior" }>;
  onAddSection?: () => void;
}

export function SpineNav({ active, statuses, onSelect, customSections = [], ocularHealthSections = [], onAddSection }: Props) {
  const cupDiscIndex = SECTIONS.findIndex((section) => section.id === "cup-disc");
  const anterior = ocularHealthSections.filter((section) => section.segment !== "posterior");
  const posterior = ocularHealthSections.filter((section) => section.segment === "posterior");
  const sections: SpineSection[] = [
    ...SECTIONS.slice(0, cupDiscIndex),
    ...anterior.map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "ANTERIOR SEGMENT" })),
    ...posterior.slice(0, 1).map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "POSTERIOR SEGMENT" })),
    SECTIONS[cupDiscIndex]!,
    ...posterior.slice(1).map((section) => ({ ...section, group: "OCULAR HEALTH", subHeader: "POSTERIOR SEGMENT" })),
    ...SECTIONS.slice(cupDiscIndex + 1),
    ...customSections,
  ];
  const groups = groupedSections(sections);
  const activeGroup = sections.find((section) => section.id === active)?.group;
  const [openGroup, setOpenGroup] = useState<string | undefined>(() => activeGroup);

  useEffect(() => {
    if (activeGroup) setOpenGroup(activeGroup);
  }, [activeGroup]);

  return (
    <nav className="odos-spine-nav shrink-0 border-b border-white/10 bg-bg-panel/70 p-3 md:w-56 md:border-b-0 md:border-r md:p-3" aria-label="Exam sections">
      <div className="text-xs uppercase tracking-widest text-white/35">Spine</div>
      <div className="mt-3 flex gap-2 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
        {groups.map((group) => group.label ? (
          <SpineGroup
            key={group.label}
            label={group.label}
            sections={group.sections}
            active={active}
            statuses={statuses}
            open={openGroup === group.label}
            onToggle={() => setOpenGroup((current) => current === group.label ? undefined : group.label)}
            onSelect={onSelect}
          />
        ) : (
          <div className="w-44 shrink-0 space-y-1 md:w-full" key="ungrouped-sections">
            {group.sections.map((section, index) => (
              <SpineRow
                key={section.id}
                section={section}
                previousSection={group.sections[index - 1]}
                active={active}
                statuses={statuses}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
        {onAddSection && (
          <button
            type="button"
            onClick={onAddSection}
            className="min-h-9 w-44 shrink-0 rounded border border-dashed border-brand/45 px-3 py-1.5 text-left text-xs font-semibold text-brand-light transition hover:bg-brand/10 md:w-full"
          >
            + Add section
          </button>
        )}
      </div>
    </nav>
  );
}

function SpineGroup({ label, sections, active, statuses, open, onToggle, onSelect }: {
  label: string;
  sections: SpineSection[];
  active: ChartSectionId;
  statuses: SectionStatusMap;
  open: boolean;
  onToggle(): void;
  onSelect(section: ChartSectionId): void;
}) {
  const panelId = `spine-group-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="w-44 shrink-0 md:w-full" data-spine-group={label}>
      <button
        type="button"
        className="flex min-h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45 transition hover:bg-white/[0.05] hover:text-white/70"
        aria-controls={panelId}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
        <span className="text-sm text-white/30" aria-hidden>{open ? "−" : "+"}</span>
      </button>
      <div id={panelId} className="space-y-1 pb-1" data-spine-group-panel={label} hidden={!open}>
        {sections.map((section, index) => (
          <SpineRow
            key={section.id}
            section={section}
            previousSection={sections[index - 1]}
            active={active}
            statuses={statuses}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function SpineRow({ section, previousSection, active, statuses, onSelect }: {
  section: SpineSection;
  previousSection?: SpineSection;
  active: ChartSectionId;
  statuses: SectionStatusMap;
  onSelect(section: ChartSectionId): void;
}) {
  const status = sectionStatus(statuses, section.id);
  const state = section.readOnly ? "Read only" : status.completed ? "Complete" : "Incomplete";
  const detail = status.summary ? `${state} — ${status.summary}` : state;
  const focused = active === section.id;
  const subHeader = section.subHeader;
  const previousSubHeader = previousSection?.subHeader;
  return (
    <>
      {subHeader && subHeader !== previousSubHeader && (
        <div className="border-l border-brand/40 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-brand-light">
          {subHeader}
        </div>
      )}
      {!subHeader && previousSubHeader && <div className="border-t border-white/10" />}
      <button
        type="button"
        onClick={() => onSelect(section.id)}
        title={detail}
        aria-current={focused ? "page" : undefined}
        className={[
          "flex min-h-9 w-full items-center gap-2 rounded border px-2.5 py-1 text-left transition",
          focused ? "border-brand/70 bg-brand/15 text-white" : "border-transparent bg-bg-mid/45 text-white/75 hover:border-white/20 hover:text-white",
        ].join(" ")}
      >
        <span
          className={[
            "h-2.5 w-2.5 shrink-0 rounded-full",
            section.readOnly ? "bg-brand/70" : status.completed ? "bg-emerald-400" : "bg-white/25",
          ].join(" ")}
          data-status={section.readOnly ? "read-only" : status.completed ? "complete" : "incomplete"}
          role="img"
          aria-label={detail}
          title={detail}
        />
        <span className="min-w-0 truncate text-xs font-semibold">{section.label}</span>
      </button>
    </>
  );
}

function groupedSections(sections: SpineSection[]): Array<{ label?: string; sections: SpineSection[] }> {
  return sections.reduce<Array<{ label?: string; sections: SpineSection[] }>>((groups, section) => {
    const current = groups.at(-1);
    if (current && current.label === section.group) current.sections.push(section);
    else groups.push({ label: section.group, sections: [section] });
    return groups;
  }, []);
}
