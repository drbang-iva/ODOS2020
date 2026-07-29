import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

export type ImagingCategory =
  | "visual-field"
  | "fundus-photo"
  | "anterior-segment-photo"
  | "oct"
  | "biometry"
  | "referral-scan"
  | "outside-record"
  | "other";

export interface ImagingSummary {
  id: string;
  mediaReference: string;
  encounterReference?: string;
  category: ImagingCategory;
  structure?: string;
  laterality?: "OD" | "OS" | "OU" | "UNKNOWN";
  date: string;
  title: string;
  device?: string;
  contentType: string;
  contentUrl?: string;
  contentState: "available" | "missing";
}

export interface ImagingCategoryGroup {
  category: ImagingCategory;
  label: string;
  structures: Array<{
    label?: string;
    dates: Array<{ date: string; images: ImagingSummary[] }>;
  }>;
}

interface ImagingPayload {
  images?: ImagingSummary[];
  error?: string;
}

const CONTENT_TYPE_BY_EXTENSION = {
  pdf: "application/pdf",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
} as const;
const ACCEPTED_FILE_TYPES = Object.keys(CONTENT_TYPE_BY_EXTENSION).map((extension) => `.${extension}`).join(",");
const ACCEPTED_CONTENT_TYPES = new Set<string>(Object.values(CONTENT_TYPE_BY_EXTENSION));
const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const CATEGORY_OPTIONS = [
  ["visual-field", "Visual field printout"],
  ["fundus-photo", "Fundus photo"],
  ["anterior-segment-photo", "Anterior slit-lamp photo"],
  ["oct", "OCT"],
  ["biometry", "Biometry"],
  ["referral-scan", "Referral scan"],
  ["outside-record", "Outside record"],
  ["other", "Other imaging or document"],
] as const;

export function ImagingSection({ patientReference, encounterReference, onSaved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const retriedImages = useRef(new Set<string>());
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORY_OPTIONS)[number][0]>("visual-field");
  const [interpretation, setInterpretation] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [images, setImages] = useState<ImagingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"patient" | "encounter">("patient");
  const [refinement, setRefinement] = useState<{
    id: string;
    structure: string;
    laterality: "" | "OD" | "OS" | "OU" | "UNKNOWN";
    confidence: "provisional" | "clinician-confirmed";
  }>();
  const [refining, setRefining] = useState(false);

  async function loadImages(nextScope = scope): Promise<ImagingSummary[]> {
    const query = new URLSearchParams(
      nextScope === "patient"
        ? { patient: patientReference }
        : { encounter: encounterReference },
    );
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/imaging?${query}`, {
      headers: authHeaders(),
    });
    const body = await response.json() as ImagingPayload;
    if (!response.ok) throw new Error(body.error ?? `Imaging history failed: ${response.status}`);
    const nextImages = body.images ?? [];
    setImages(nextImages);
    return nextImages;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    retriedImages.current.clear();
    loadImages(scope)
      .catch((caught) => {
        if (!cancelled) setError(messageOf(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientReference, encounterReference, scope]);

  const groups = useMemo(() => groupImagingRows(images), [images]);

  function chooseFile(next: File | undefined) {
    setSaved(null);
    setError(null);
    if (!next) return;
    if (!imagingContentType(next)) {
      setFile(null);
      setError("Unsupported file type.");
      return;
    }
    if (next.size > MAX_FILE_BYTES) {
      setFile(null);
      setError("Files may not exceed 15 MB.");
      return;
    }
    setFile(next);
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  }

  async function upload() {
    if (!file) return;
    const contentType = imagingContentType(file);
    if (!contentType) {
      setFile(null);
      setError("Unsupported file type.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/imaging`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/vnd.odos.manual-imaging+json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          category,
          ...(interpretation.trim() ? { interpretation: interpretation.trim() } : {}),
          file: {
            name: file.name,
            contentType,
            data: await fileBase64(file),
          },
        }),
      });
      const body = await response.json() as { mediaReference?: string; error?: string };
      if (!response.ok || !body.mediaReference) {
        throw new Error(body.error ?? `Imaging upload failed: ${response.status}`);
      }
      const summary = `${file.name} uploaded`;
      setSaved(summary);
      setFile(null);
      setInterpretation("");
      if (inputRef.current) inputRef.current.value = "";
      await loadImages();
      onSaved({
        completed: true,
        summary,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI manual imaging",
      });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  }

  async function retryImage(image: ImagingSummary) {
    if (retriedImages.current.has(image.id)) {
      setImages((current) => current.map((row) =>
        row.id === image.id ? { ...row, contentUrl: undefined, contentState: "missing" } : row
      ));
      return;
    }
    retriedImages.current.add(image.id);
    try {
      const refreshed = await loadImages();
      const replacement = refreshed.find((row) => row.id === image.id);
      if (!replacement?.contentUrl || replacement.contentUrl === image.contentUrl) {
        setImages((current) => current.map((row) =>
          row.id === image.id ? { ...row, contentUrl: undefined, contentState: "missing" } : row
        ));
      }
    } catch {
      setImages((current) => current.map((row) =>
        row.id === image.id ? { ...row, contentUrl: undefined, contentState: "missing" } : row
      ));
    }
  }

  async function saveRefinement() {
    if (!refinement?.structure.trim()) return;
    setRefining(true);
    setError(null);
    try {
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/imaging/${encodeURIComponent(refinement.id)}/structure`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            structure: refinement.structure.trim(),
            ...(refinement.laterality ? { laterality: refinement.laterality } : {}),
            confidence: refinement.confidence,
          }),
        },
      );
      const body = await response.json() as { image?: ImagingSummary; error?: string };
      if (!response.ok || !body.image) {
        throw new Error(body.error ?? `Structure refinement failed: ${response.status}`);
      }
      setImages((current) => current.map((row) => row.id === body.image!.id ? body.image! : row));
      setRefinement(undefined);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setRefining(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Imaging</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Review chart imaging by category and date, or add a native capture.</p>
          </div>
          <div className="flex rounded border border-[color:var(--odos-line)] bg-bg-panel p-1">
            <button type="button" aria-pressed={scope === "patient"} className={scope === "patient" ? "sidebar-button" : "px-3 py-1 text-xs text-[color:var(--odos-muted)]"} onClick={() => setScope("patient")}>All chart imaging</button>
            <button type="button" aria-pressed={scope === "encounter"} className={scope === "encounter" ? "sidebar-button" : "px-3 py-1 text-xs text-[color:var(--odos-muted)]"} onClick={() => setScope("encounter")}>This visit</button>
          </div>
        </div>

        {error && <div role="alert" className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        {loading && <p className="mt-5 text-sm text-[color:var(--odos-muted)]">Loading imaging history…</p>}
        {!loading && groups.length === 0 && <p className="mt-5 rounded border border-[color:var(--odos-line)] bg-bg-panel/50 p-4 text-sm text-[color:var(--odos-muted)]">No imaging recorded for this scope.</p>}

        <div className="mt-5 space-y-5">
          {groups.map((group) => (
            <section key={group.category} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/55 p-4" data-imaging-category={group.category}>
              <h3 className="text-sm font-semibold uppercase tracking-widest text-brand-light">{group.label}</h3>
              <div className="mt-3 space-y-4">
                {group.structures.map((structureGroup) => (
                  <section key={structureGroup.label ?? "all"}>
                    {structureGroup.label && <h4 className="mb-2 text-sm font-medium text-[color:var(--odos-text)]">{structureGroup.label}</h4>}
                    <div className="space-y-3">
                      {structureGroup.dates.map((dateGroup) => (
                        <section key={dateGroup.date}>
                          <h5 className="mb-2 text-xs font-medium uppercase tracking-wider text-[color:var(--odos-faint)]">{displayDate(dateGroup.date)}</h5>
                          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            {dateGroup.images.map((image) => (
                              <ImagingTile
                                key={image.id}
                                image={image}
                                onImageError={() => void retryImage(image)}
                                onRefine={image.category === "oct" ? () => setRefinement({
                                  id: image.id,
                                  structure: image.structure ?? "",
                                  laterality: image.laterality ?? "",
                                  confidence: "clinician-confirmed",
                                }) : undefined}
                              />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          ))}
        </div>

        {refinement && (
          <section className="mt-5 rounded border border-violet-300/25 bg-violet-300/5 p-4" aria-label="Refine OCT structure">
            <h3 className="text-sm font-semibold text-violet-100">Refine OCT structure</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <input aria-label="OCT structure" className="sidebar-input" value={refinement.structure} placeholder="e.g. Optic nerve or Macula" onChange={(event) => setRefinement({ ...refinement, structure: event.target.value })} />
              <select aria-label="OCT laterality" className="sidebar-input" value={refinement.laterality} onChange={(event) => setRefinement({ ...refinement, laterality: event.target.value as typeof refinement.laterality })}>
                <option value="">Laterality not recorded</option>
                <option value="OD">Right eye (OD)</option>
                <option value="OS">Left eye (OS)</option>
                <option value="OU">Both eyes (OU)</option>
                <option value="UNKNOWN">Unknown eye</option>
              </select>
              <select aria-label="Refinement confidence" className="sidebar-input" value={refinement.confidence} onChange={(event) => setRefinement({ ...refinement, confidence: event.target.value as typeof refinement.confidence })}>
                <option value="clinician-confirmed">Clinician confirmed</option>
                <option value="provisional">Provisional</option>
              </select>
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" className="sidebar-button" disabled={refining || !refinement.structure.trim()} onClick={() => void saveRefinement()}>{refining ? "Saving…" : "Save refinement"}</button>
              <button type="button" className="px-3 py-2 text-sm text-[color:var(--odos-muted)]" disabled={refining} onClick={() => setRefinement(undefined)}>Cancel</button>
            </div>
          </section>
        )}

        <details className="mt-6 rounded border border-[color:var(--odos-line)] bg-bg-panel/55 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-brand-light">Capture or import imaging</summary>
          <div className="mt-4">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload imaging file"
              className={[
                "flex min-h-36 cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-6 py-6 text-center transition",
                dragging ? "border-brand bg-brand/15" : "border-[color:var(--odos-line-2)] bg-bg-mid/50 hover:border-brand/60",
              ].join(" ")}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={dropFile}
            >
              <span className="text-base font-semibold text-[color:var(--odos-text)]">Drop a scan or image here</span>
              <span className="mt-2 text-sm text-[color:var(--odos-muted)]">or choose a PDF, JPEG, PNG, TIFF, HEIC, BMP, or WebP file · 15 MB max</span>
              {file && <span className="mt-4 rounded bg-brand/15 px-3 py-2 text-sm text-brand-light">{file.name} · {formatBytes(file.size)}</span>}
            </div>
            <input ref={inputRef} aria-label="Choose imaging file" className="sr-only" type="file" accept={ACCEPTED_FILE_TYPES} onChange={(event) => chooseFile(event.target.files?.[0])} />

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <label className="text-sm text-[color:var(--odos-muted)]">
                Artifact type
                <select aria-label="Artifact type" className="sidebar-input mt-2" value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
                  {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="text-sm text-[color:var(--odos-muted)] lg:row-span-2">
                Interpretation (optional)
                <textarea aria-label="Interpretation (optional)" className="sidebar-input mt-2 min-h-32 resize-y" value={interpretation} maxLength={5000} onChange={(event) => setInterpretation(event.target.value)} placeholder="Enter findings only when this artifact is being interpreted now." />
                <span className="mt-1 block text-xs text-[color:var(--odos-faint)]">Creates a preliminary DiagnosticReport linked to the uploaded Media.</span>
              </label>
            </div>

            {saved && <div role="status" className="mt-4 rounded border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100">{saved}</div>}
            <button type="button" className="sidebar-button mt-5" disabled={!file || saving} onClick={() => void upload()}>
              {saving ? "Uploading…" : "Upload to chart"}
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}

function ImagingTile({
  image,
  onImageError,
  onRefine,
}: {
  image: ImagingSummary;
  onImageError: () => void;
  onRefine?: () => void;
}) {
  const imageContent = image.contentType.startsWith("image/");
  return (
    <article className="overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-deep" data-imaging-id={image.id}>
      {image.contentState === "missing" || !image.contentUrl ? (
        <div className="flex aspect-[4/3] items-center justify-center bg-red-950/20 p-4 text-center text-sm text-red-200" role="img" aria-label={`${image.title} unavailable`}>
          Image unavailable. Metadata remains in the chart.
        </div>
      ) : imageContent ? (
        <img className="aspect-[4/3] w-full bg-[color:var(--odos-ground)] object-contain" src={image.contentUrl} alt={image.title} onError={onImageError} />
      ) : (
        <a className="flex aspect-[4/3] items-center justify-center bg-bg-mid text-sm font-medium text-brand-light" href={image.contentUrl} target="_blank" rel="noreferrer">Open {image.contentType === "application/pdf" ? "PDF" : "attachment"}</a>
      )}
      <div className="p-3 text-xs text-[color:var(--odos-muted)]">
        <strong className="block text-sm text-[color:var(--odos-text)]">{image.title}</strong>
        <span>{[image.structure, image.laterality, image.device].filter(Boolean).join(" · ") || "Structure and device not recorded"}</span>
        {onRefine && <button type="button" className="mt-2 block text-brand-light" onClick={onRefine}>Refine structure</button>}
      </div>
    </article>
  );
}

export function groupImagingRows(images: readonly ImagingSummary[]): ImagingCategoryGroup[] {
  return CATEGORY_OPTIONS.flatMap(([category, label]) => {
    const categoryRows = images
      .filter((image) => image.category === category)
      .sort((left, right) => right.date.localeCompare(left.date));
    if (!categoryRows.length) return [];
    const structures = category === "oct"
      ? unique(categoryRows.map((image) => image.structure?.trim() || "Unclassified OCT"))
      : [undefined];
    return [{
      category,
      label,
      structures: structures.map((structure) => {
        const structureRows = category === "oct"
          ? categoryRows.filter((image) => (image.structure?.trim() || "Unclassified OCT") === structure)
          : categoryRows;
        const dates = unique(structureRows.map((image) => dateKey(image.date)));
        return {
          ...(structure ? { label: structure } : {}),
          dates: dates.map((date) => ({
            date,
            images: structureRows.filter((image) => dateKey(image.date) === date),
          })),
        };
      }),
    }];
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function imagingContentType(file: Pick<File, "name" | "type">): string | undefined {
  const contentType = file.type.trim().toLowerCase() || contentTypeFromName(file.name);
  return contentType && ACCEPTED_CONTENT_TYPES.has(contentType) ? contentType : undefined;
}

function contentTypeFromName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension && extension in CONTENT_TYPE_BY_EXTENSION
    ? CONTENT_TYPE_BY_EXTENSION[extension as keyof typeof CONTENT_TYPE_BY_EXTENSION]
    : undefined;
}

async function fileBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 8192) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function dateKey(value: string): string {
  if (!value) return "Date not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function displayDate(value: string): string {
  if (value === "Date not recorded") return value;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { dateStyle: "long" });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
