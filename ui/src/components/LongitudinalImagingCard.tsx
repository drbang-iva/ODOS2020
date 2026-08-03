import { useEffect, useMemo, useRef, useState } from "react";
import { OdosSearchPicker } from "./inputs/OdosSearchPicker";
import { OdosSelect } from "./inputs/OdosSelect";
import { authHeaders, clinicalGraphApiBase } from "../lib/clinical-graph-client";

export type PhotoLens = "timeline" | "compare";

interface ProcedureDefinitionSummary {
  stableKey: string;
  display: string;
  photo_posture: PhotoLens;
}

export interface LongitudinalImageSummary {
  mediaReference: string;
  createdAt: string;
  title: string;
  contentType: string;
  contentUrl?: string;
  contentState: "available" | "missing";
  structure: string;
  seriesReference?: string;
  procedureReference?: string;
}

interface ImagingPayload {
  images: LongitudinalImageSummary[];
  suggestedPair?: [string, string];
  error?: string;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function LongitudinalImagingCard({
  patientReference,
  hideWhenEmpty = false,
}: {
  patientReference: string;
  hideWhenEmpty?: boolean;
}) {
  const retriedImages = useRef(new Set<string>());
  const activePatient = useRef(patientReference);
  activePatient.current = patientReference;
  const [definitions, setDefinitions] = useState<ProcedureDefinitionSummary[]>([]);
  const [definitionKey, setDefinitionKey] = useState("");
  const [lens, setLens] = useState<PhotoLens>("timeline");
  const [images, setImages] = useState<LongitudinalImageSummary[]>([]);
  const [suggestedPair, setSuggestedPair] = useState<[string, string]>();
  const [baselineReference, setBaselineReference] = useState("");
  const [currentReference, setCurrentReference] = useState("");
  const [structure, setStructure] = useState("Lid margin");
  const [file, setFile] = useState<File>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [overlayOpacity, setOverlayOpacity] = useState(45);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function loadImages(requestedPatient: string): Promise<ImagingPayload> {
    const response = await fetch(
      `${clinicalGraphApiBase()}/clinical-graph/longitudinal-imaging?patient=${encodeURIComponent(requestedPatient)}`,
      { headers: authHeaders() },
    );
    const body = await response.json() as ImagingPayload;
    if (!response.ok) throw new Error(body.error ?? `Clinical-photo timeline failed: ${response.status}`);
    return { ...body, images: body.images ?? [] };
  }

  useEffect(() => {
    let cancelled = false;
    retriedImages.current.clear();
    Promise.all([
      fetch(`${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`, { headers: authHeaders() })
        .then(async (response) => {
          const body = await response.json() as { definitions?: ProcedureDefinitionSummary[]; error?: string };
          if (!response.ok) throw new Error(body.error ?? `Procedure definitions failed: ${response.status}`);
          return body.definitions ?? [];
        }),
      loadImages(patientReference),
    ]).then(([nextDefinitions, payload]) => {
      if (cancelled) return;
      setDefinitions(nextDefinitions);
      setDefinitionKey(nextDefinitions[0]?.stableKey ?? "");
      setLens(defaultPhotoLens(nextDefinitions[0]));
      setImages(payload.images);
      setSuggestedPair(payload.suggestedPair);
    }).catch((cause) => !cancelled && setError(messageOf(cause)));
    return () => { cancelled = true; };
  }, [patientReference]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const pair = suggestedPair ?? suggestImagePair(images);
    setBaselineReference(pair?.[0] ?? "");
    setCurrentReference(pair?.[1] ?? "");
  }, [images, suggestedPair]);

  const baseline = images.find((image) => image.mediaReference === baselineReference);
  const current = images.find((image) => image.mediaReference === currentReference);
  const ghost = useMemo(() => images.find((image) =>
    image.structure.toLocaleLowerCase() === structure.trim().toLocaleLowerCase()
  ), [images, structure]);

  function chooseDefinition(stableKey: string) {
    setDefinitionKey(stableKey);
    setLens(defaultPhotoLens(definitions.find((definition) => definition.stableKey === stableKey)));
  }

  function chooseFile(next: File | undefined) {
    setError(undefined);
    if (!next) {
      setFile(undefined);
      return;
    }
    if (!next.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (next.size > MAX_FILE_BYTES) {
      setError("Clinical photos may not exceed 15 MB.");
      return;
    }
    setFile(next);
  }

  async function capture() {
    if (!file || !definitionKey || !structure.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/longitudinal-imaging`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/vnd.odos.longitudinal-imaging+json" },
        body: JSON.stringify({
          patientReference,
          procedureDefinitionStableKey: definitionKey,
          structure: structure.trim(),
          file: {
            name: file.name,
            contentType: file.type,
            data: await fileBase64(file),
          },
        }),
      });
      const body = await response.json() as { image?: LongitudinalImageSummary; defaultLens?: PhotoLens; error?: string };
      if (!response.ok || !body.image) {
        throw new Error(body.error ?? `Clinical-photo capture failed: ${response.status}`);
      }
      if (patientReference !== activePatient.current) return;
      setFile(undefined);
      setLens(body.defaultLens ?? lens);
      setImages((currentImages) => [body.image!, ...currentImages]);
      try {
        const payload = await loadImages(patientReference);
        if (patientReference !== activePatient.current) return;
        setImages(payload.images);
        setSuggestedPair(payload.suggestedPair);
      } catch (refreshError) {
        console.error("Clinical photo saved but the longitudinal timeline could not refresh.", refreshError);
        setError("Photo saved. Refresh the chart to reload the longitudinal timeline.");
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  async function retryImage(image: LongitudinalImageSummary) {
    if (retriedImages.current.has(image.mediaReference)) {
      setImages((currentImages) => currentImages.map((candidate) =>
        candidate.mediaReference === image.mediaReference
          ? { ...candidate, contentUrl: undefined, contentState: "missing" }
          : candidate
      ));
      return;
    }
    retriedImages.current.add(image.mediaReference);
    const requestedPatient = patientReference;
    try {
      const payload = await loadImages(requestedPatient);
      if (requestedPatient !== activePatient.current) return;
      setImages(payload.images);
      setSuggestedPair(payload.suggestedPair);
      const replacement = payload.images.find((candidate) => candidate.mediaReference === image.mediaReference);
      if (replacement?.contentUrl && replacement.contentUrl !== image.contentUrl) {
        retriedImages.current.delete(image.mediaReference);
        return;
      }
      if (!replacement?.contentUrl || replacement.contentUrl === image.contentUrl) {
        setImages((currentImages) => currentImages.map((candidate) =>
          candidate.mediaReference === image.mediaReference
            ? { ...candidate, contentUrl: undefined, contentState: "missing" }
            : candidate
        ));
      }
    } catch {
      if (requestedPatient !== activePatient.current) return;
      setImages((currentImages) => currentImages.map((candidate) =>
        candidate.mediaReference === image.mediaReference
          ? { ...candidate, contentUrl: undefined, contentState: "missing" }
          : candidate
      ));
    }
  }

  if (hideWhenEmpty && images.length === 0) return null;

  return (
    <section data-testid="longitudinal-imaging-card" className="rounded border border-white/10 bg-bg-mid/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Longitudinal imaging</h3>
          <p className="mt-1 text-xs text-white/40">Clinical photos across visits</p>
        </div>
        <div className="flex rounded border border-white/10 bg-bg-deep p-0.5">
          {(["timeline", "compare"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={lens === value}
              className={`rounded px-2 py-1 text-[11px] capitalize ${lens === value ? "bg-brand/25 text-brand-light" : "text-white/45"}`}
              onClick={() => setLens(value)}
            >
              {value === "timeline" ? "Timeline" : "Compare"}
            </button>
          ))}
        </div>
      </div>

      {error && <div role="alert" className="mt-3 rounded border border-red-400/40 bg-red-400/10 p-2 text-xs text-red-100">{error}</div>}

      {lens === "timeline" ? (
        <div className="mt-3 space-y-2">
          {images.length === 0 && <p className="text-xs text-white/40">No longitudinal photos recorded.</p>}
          {images.map((image) => (
            <figure key={image.mediaReference} className="overflow-hidden rounded border border-white/10 bg-bg-deep">
              {image.contentState === "available" && image.contentUrl ? (
                <img className="aspect-[4/3] w-full object-cover" src={image.contentUrl} alt={`${image.structure} ${localDate(image.createdAt)}`} onError={() => void retryImage(image)} />
              ) : (
                <div role="img" aria-label={`${image.title} unavailable`} className="flex aspect-[4/3] items-center justify-center bg-red-950/20 p-3 text-center text-xs text-red-200">
                  Image unavailable. Metadata remains in the chart.
                </div>
              )}
              <figcaption className="p-2 text-xs text-white/55">
                <strong className="block text-white/75">{image.structure}</strong>
                {localDate(image.createdAt)} · {image.title}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {images.length < 2 ? (
            <p className="text-xs text-white/40">Two photos are needed for comparison.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <ImageSelect label="Baseline" value={baselineReference} images={images} onChange={setBaselineReference} />
                <ImageSelect label="Current" value={currentReference} images={images} onChange={setCurrentReference} />
              </div>
              <div className="grid grid-cols-2 gap-1 overflow-hidden rounded border border-white/10 bg-bg-deep">
                {baseline && <ImageTile image={baseline} label="Baseline" onImageError={() => void retryImage(baseline)} />}
                {current && <ImageTile image={current} label="Current" onImageError={() => void retryImage(current)} />}
              </div>
              {baseline?.seriesReference && baseline.seriesReference === current?.seriesReference && (
                <p className="text-[11px] text-brand-light">Suggested from the same treatment series.</p>
              )}
            </>
          )}
        </div>
      )}

      <details className="mt-3 border-t border-white/10 pt-3">
        <summary className="cursor-pointer text-xs font-semibold text-brand-light">Capture or import photo</summary>
        <div className="mt-3 space-y-2">
          <select aria-label="Procedure or protocol" className="sidebar-input" value={definitionKey} onChange={(event) => chooseDefinition(event.target.value)}>
            {definitions.length === 0 && <option value="">No active procedure definitions</option>}
            {definitions.map((definition) => <option key={definition.stableKey} value={definition.stableKey}>{definition.display}</option>)}
          </select>
          <OdosSelect
            ariaLabel="Anatomical structure"
            value={structure}
            options={[...new Set([
              ...images.map((image) => image.structure.trim()),
              structure.trim(),
            ].filter(Boolean))].map((value) => ({ value, label: value }))}
            onChange={setStructure}
            onInputChange={setStructure}
            parseInput={(input) => input}
            serializeValue={(value) => value}
            maxLength={120}
          />
          <input aria-label="Choose clinical photo" type="file" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} className="block w-full text-xs text-white/50" />
          {previewUrl && (
            <div className="relative aspect-[4/3] overflow-hidden rounded border border-white/10 bg-black">
              <img src={previewUrl} alt="New clinical photo preview" className="absolute inset-0 h-full w-full object-contain" />
              {ghost && (
                ghost.contentState === "available" && ghost.contentUrl && (
                  <img
                    src={ghost.contentUrl}
                    alt="Prior photo alignment guide"
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                    style={{ opacity: overlayOpacity / 100 }}
                    onError={() => void retryImage(ghost)}
                  />
                )
              )}
            </div>
          )}
          {previewUrl && ghost && (
            <label className="block text-[11px] text-white/45">
              Ghost overlay {overlayOpacity}%
              <input aria-label="Ghost overlay opacity" className="mt-1 w-full" type="range" min="0" max="100" value={overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} />
            </label>
          )}
          <p className="text-[11px] text-white/35">Documented cosmetic consent is checked before capture.</p>
          <button type="button" className="sidebar-button w-full" disabled={!file || !definitionKey || !structure.trim() || saving} onClick={capture}>
            {saving ? "Saving…" : "Save clinical photo"}
          </button>
        </div>
      </details>
    </section>
  );
}

export function defaultPhotoLens(definition: Pick<ProcedureDefinitionSummary, "photo_posture"> | undefined): PhotoLens {
  return definition?.photo_posture === "compare" ? "compare" : "timeline";
}

export function suggestImagePair(images: readonly LongitudinalImageSummary[]): [string, string] | undefined {
  for (let currentIndex = 0; currentIndex < images.length; currentIndex += 1) {
    const current = images[currentIndex]!;
    if (!current.seriesReference) continue;
    const baseline = images.slice(currentIndex + 1).find((candidate) =>
      candidate.seriesReference === current.seriesReference && candidate.structure === current.structure
    );
    if (baseline) return [baseline.mediaReference, current.mediaReference];
  }
  return images.length >= 2
    ? [images[images.length - 1]!.mediaReference, images[0]!.mediaReference]
    : undefined;
}

function ImageSelect({
  label,
  value,
  images,
  onChange,
}: {
  label: string;
  value: string;
  images: LongitudinalImageSummary[];
  onChange: (value: string) => void;
}) {
  const selected = images.find((image) => image.mediaReference === value);
  return (
    <OdosSearchPicker
      label={`${label} image`}
      value={value}
      selectedLabel={selected ? `${localDate(selected.createdAt)} · ${selected.structure}` : undefined}
      placeholder={`Search ${label.toLocaleLowerCase()} images`}
      search={async (query) => {
        const normalized = query.trim().toLocaleLowerCase();
        return images
          .filter((image) => `${localDate(image.createdAt)} ${image.structure} ${image.title}`.toLocaleLowerCase().includes(normalized))
          .map((image) => ({
            value: image.mediaReference,
            label: `${localDate(image.createdAt)} · ${image.structure}`,
            description: image.title,
            item: image,
          }));
      }}
      onClear={() => onChange("")}
      onSelect={(option) => onChange(option.value)}
    />
  );
}

function ImageTile({
  image,
  label,
  onImageError,
}: {
  image: LongitudinalImageSummary;
  label: string;
  onImageError: () => void;
}) {
  return (
    <figure className="min-w-0">
      {image.contentState === "available" && image.contentUrl ? (
        <img className="aspect-square w-full object-cover" src={image.contentUrl} alt={`${label}: ${image.structure}`} onError={onImageError} />
      ) : (
        <div role="img" aria-label={`${label}: ${image.title} unavailable`} className="flex aspect-square items-center justify-center bg-red-950/20 p-2 text-center text-[10px] text-red-200">Image unavailable</div>
      )}
      <figcaption className="p-1.5 text-[10px] text-white/45">{label} · {localDate(image.createdAt)}</figcaption>
    </figure>
  );
}

function localDate(value: string): string {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString();
}

async function fileBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 8192) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
