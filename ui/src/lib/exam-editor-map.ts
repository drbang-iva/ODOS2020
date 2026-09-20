import type { ChartEditorEntry } from "../components/charting/SpineNav";
import type { ExamOverviewProjection } from "../components/charting/ExamOverviewBoard";
type ExamOverviewFindingProjection = ExamOverviewProjection["findings"][number];

export interface ExamSheetRowDefinition {
  sectionKey: string;
  label: string;
  editorGroupKey: string;
  traceSectionKeys: readonly string[];
  owner: "Tech" | "Doctor";
  rowLayout: "single" | "two-column";
  optional?: boolean;
  optionalEditorIds?: readonly ChartEditorEntry["id"][];
  singleBlank?: boolean;
}

export const EXAM_SHEET_ROWS: readonly ExamSheetRowDefinition[] = [
  { sectionKey: "history", label: "History", editorGroupKey: "history", traceSectionKeys: ["history"], owner: "Doctor", rowLayout: "single" },
  { sectionKey: "pretest", label: "Pretest", editorGroupKey: "pretest", traceSectionKeys: ["entrance", "pretest"], owner: "Tech", rowLayout: "two-column" },
  { sectionKey: "refraction", label: "Refraction", editorGroupKey: "refraction", traceSectionKeys: ["refraction"], owner: "Doctor", rowLayout: "single", singleBlank: true },
  { sectionKey: "contact-lenses", label: "Contact Lenses", editorGroupKey: "contact-lenses", traceSectionKeys: [], owner: "Doctor", rowLayout: "single", optional: true },
  { sectionKey: "ocular-health", label: "Ocular Health", editorGroupKey: "ocular-health", traceSectionKeys: ["ocular-health"], owner: "Doctor", rowLayout: "two-column" },
  {
    sectionKey: "assessment",
    label: "Assessment & Plan",
    editorGroupKey: "assessment",
    traceSectionKeys: ["assessment"],
    owner: "Doctor",
    rowLayout: "single",
    optionalEditorIds: ["prescription"],
  },
];

export function editorSheetSection(editor: ChartEditorEntry): string {
  const key = editorGroupKey(editor.group);
  if (key === "entrance") return "pretest";
  if (EXAM_SHEET_ROWS.some(row => row.sectionKey === key)) return key;
  if (editor.id.startsWith("dry-eye:")) return "ocular-health";
  return "section-groups";
}

export function shelfGroupKey(editor: ChartEditorEntry): string {
  if (editor.id === "imaging" || editor.group === "IMAGING") return "tests";
  const key = editorSheetSection(editor);
  return ["history", "assessment"].includes(key) ? "section-groups" : key;
}

function editorGroupKey(group?: string): string {
  if (group === "ASSESSMENT & PLAN") return "assessment";
  if (!group) return "other";
  return group.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

export function sheetSectionKeyForClinicalSection(sectionKey: string): string {
  if (/^(entrance|pretest|tonometry|va|wearing|auto-refraction)(:|$)/.test(sectionKey)) return "pretest";
  if (/^(ocular-health|dry-eye|cup-disc|gonioscopy)(:|$)/.test(sectionKey)) return "ocular-health";
  if (/^refraction(:|$)/.test(sectionKey)) return "refraction";
  if (/^(history|hpi|complaints)(:|$)/.test(sectionKey)) return "history";
  if (/^(assessment|plan|prescription)(:|$)/.test(sectionKey)) return "assessment";
  if (/^contact-lenses?(:|$)/.test(sectionKey)) return "contact-lenses";
  return "section-groups";
}

export interface FindingGroup {
  findingKey: string;
  display: string;
  rows: ExamOverviewFindingProjection[];
}

export function groupFindings(findings: readonly ExamOverviewFindingProjection[]): FindingGroup[] {
  const groups = new Map<string, ExamOverviewFindingProjection[]>();
  for (const finding of findings) {
    const key = `${finding.findingKey}\u0000${finding.display}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].map((rows) => ({
    findingKey: rows[0]!.findingKey,
    display: rows[0]!.display,
    rows: rows.sort((left, right) => lateralityOrder(left.laterality) - lateralityOrder(right.laterality)),
  }));
}

export function lateralityOrder(laterality: ExamOverviewFindingProjection["laterality"]): number {
  return { OD: 0, OS: 1, OU: 2, UNKNOWN: 3 }[laterality];
}

export const FINDING_EDITOR_MAP: Readonly<Record<string, string | undefined>> = {
    "entrance:cover": "cover-test",
    "entrance:color": "color-vision",
    "entrance:stereo": "stereopsis",
    intraocular_pressure: "iop",
    cup_disc_ratio: "cup-disc",
    manual_keratometry: "manual-keratometry",
    auto_refraction: "auto-refraction",
    hpi_ros: "hpi",
};

export function editorForFinding(
  group: FindingGroup,
  editorEntries: readonly ChartEditorEntry[],
): ChartEditorEntry | undefined {
  const knownEditor = FINDING_EDITOR_MAP[group.findingKey];
  const candidates = [
    knownEditor,
    group.findingKey,
    group.findingKey.split(":").at(-1),
    group.rows[0]?.sectionKey,
    group.rows[0]?.sectionKey.split(":").at(-1),
    group.findingKey === "pachymetry_um" ? "pachymetry" : undefined,
    group.findingKey === "entrance:cvf" ? "cvf" : undefined,
    group.findingKey === "entrance:eom" ? "eom" : undefined,
  ].filter(Boolean);
  return editorEntries.find((entry) => candidates.includes(entry.id));
}

export type EditorDataEvidence = "projection" | "unknown" | "never-shelvable";
export type HoldsData = boolean | "unknown";
export const EDITOR_DATA_EVIDENCE: Readonly<Record<string, EditorDataEvidence | undefined>> = {
  hpi: "never-shelvable",
  wearing: "unknown",
  "auto-refraction": "projection",
  "pretest-vitals": "unknown",
  "manual-keratometry": "projection",
  pachymetry: "unknown",
  va: "unknown",
  pupils: "unknown",
  stereopsis: "projection",
  "color-vision": "projection",
  eom: "unknown",
  cvf: "unknown",
  "cover-test": "projection",
  iop: "projection",
  dilation: "unknown",
  refraction: "unknown",
  "refraction-history": "unknown",
  "eye-growth": "unknown",
  "soft-contact-lens": "unknown",
  "specialty-contact-lens": "unknown",
  "ortho-k": "unknown",
  "myopia-management": "unknown",
  "cup-disc": "projection",
  gonioscopy: "unknown",
  "dry-eye": "unknown",
  imaging: "unknown",
  assessment: "never-shelvable",
  prescription: "unknown",
  "aesthetics-consent": "unknown",
  "ocular-health:": "projection",
  "custom:": "projection",
  "dry-eye:tear-volume": "projection",
  "dry-eye:": "unknown",
  "procedure:": "unknown",
};

export function editorDataEvidence(editorId: string): EditorDataEvidence | undefined {
  if (Object.hasOwn(EDITOR_DATA_EVIDENCE, editorId)) return EDITOR_DATA_EVIDENCE[editorId];
  return EDITOR_DATA_EVIDENCE[`${editorId.split(":")[0]}:`];
}

export function holdsData(editor: ChartEditorEntry, projection: ExamOverviewProjection,
  editorEntries: readonly ChartEditorEntry[] = [editor]): HoldsData {
  if (editorSheetSection(editor) === "history" && projection.historySummary) return true;
  const groups = groupFindings(projection.findings);
  if (groups.some(group => editorForFinding(group, editorEntries)?.id === editor.id)) return true;
  const clinicalSectionByReference = new Map(projection.sections.flatMap(section =>
    (section.findingObservationReferences ?? []).map(reference => [reference, section.sectionKey] as const)
  ));
  if (groups.some(group => !editorForFinding(group, editorEntries) &&
    sheetSectionKeyForClinicalSection(clinicalSectionByReference.get(group.rows[0]!.observationReference) ?? group.rows[0]!.sectionKey) === editorSheetSection(editor)
  )) return "unknown";
  return editorDataEvidence(editor.id) === "projection" ? false : "unknown";
}
