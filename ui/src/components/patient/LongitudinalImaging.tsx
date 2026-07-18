import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type RefObject,
} from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";

export type ImagingLens = "timeline" | "compare";

export interface LongitudinalPhoto {
  mediaReference: string;
  recordedAt: string;
  title: string;
  contentType: string;
  dataUrl: string;
  structure: string;
  encounterReference?: string;
  seriesReference?: string;
}

export interface ImagingEncounterOption {
  reference: string;
  label: string;
}

interface ProcedureDefinitionOption {
  stableKey: string;
  display: string;
  photo_posture: "monitoring" | "showcase";
}

interface SuggestedPair {
  first: string;
  second: string;
  source: "series" | "recent";
  seriesReference?: string;
}

export function LongitudinalImaging({
  patientReference,
  encounters,
}: {
  patientReference: string;
  encounters: readonly ImagingEncounterOption[];
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream>();
  const [definitions, setDefinitions] = useState<ProcedureDefinitionOption[]>([]);
  const [definitionKey, setDefinitionKey] = useState("");
  const [encounterReference, setEncounterReference] = useState(encounters[0]?.reference ?? "");
  const [structureDraft, setStructureDraft] = useState("Meibomian glands");
  const [structure, setStructure] = useState("Meibomian glands");
  const [photos, setPhotos] = useState<LongitudinalPhoto[]>([]);
  const [lens, setLens] = useState<ImagingLens>("timeline");
  const [suggestedPair, setSuggestedPair] = useState<SuggestedPair>();
  const [firstReference, setFirstReference] = useState("");
  const [secondReference, setSecondReference] = useState("");
  const [consented, setConsented] = useState(false);
  const [consentAcknowledged, setConsentAcknowledged] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      requestJson<{ definitions?: ProcedureDefinitionOption[] }>(
        `${clinicalGraphApiBase()}/clinical-graph/procedure-definitions`,
      ),
      requestJson<{ consented?: boolean }>(
        `${clinicalGraphApiBase()}/clinical-graph/clinical-photography-consent?patient=${encodeURIComponent(patientReference)}`,
      ),
    ]).then(([catalog, consent]) => {
      if (!active) return;
      const options = (catalog.definitions ?? []).filter((candidate) =>
        candidate.stableKey && candidate.display &&
        (candidate.photo_posture === "monitoring" || candidate.photo_posture === "showcase")
      );
      setDefinitions(options);
      setConsented(Boolean(consent.consented));
    }).catch((cause) => active && setError(messageOf(cause)));
    return () => { active = false; };
  }, [patientReference]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({ patient: patientReference, structure });
    if (definitionKey) params.set("procedureDefinitionStableKey", definitionKey);
    requestJson<{
      photos?: LongitudinalPhoto[];
      suggestedPair?: SuggestedPair;
      defaultLens?: ImagingLens;
    }>(`${clinicalGraphApiBase()}/clinical-graph/longitudinal-imaging?${params}`)
      .then((body) => {
        if (!active) return;
        const nextPhotos = body.photos ?? [];
        setPhotos(nextPhotos);
        setSuggestedPair(body.suggestedPair);
        setLens(body.defaultLens ?? "timeline");
        const fallback = nextPhotos.length >= 2
          ? {
              first: nextPhotos[nextPhotos.length - 2]!.mediaReference,
              second: nextPhotos[nextPhotos.length - 1]!.mediaReference,
            }
          : undefined;
        const pair = body.suggestedPair ?? fallback;
        setFirstReference(pair?.first ?? "");
        setSecondReference(pair?.second ?? "");
      })
      .catch((cause) => active && setError(messageOf(cause)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [definitionKey, patientReference, revision, structure]);

  useEffect(() => () => stopCameraStream(streamRef.current), []);

  async function recordConsent() {
    if (!consentAcknowledged || !encounterReference) return;
    setBusy(true);
    setError(undefined);
    try {
      await requestJson(
        `${clinicalGraphApiBase()}/clinical-graph/clinical-photography-consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientReference,
            encounterReference,
            acknowledged: true,
          }),
        },
      );
      setConsented(true);
      setConsentAcknowledged(false);
      setStatus("Clinical photography consent recorded.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const contentType = photoContentType(file);
    if (!contentType) {
      setError("Choose a JPEG, PNG, or HEIC image.");
      event.target.value = "";
      return;
    }
    await savePhoto({
      name: file.name,
      contentType,
      data: await fileBase64(file),
      source: "device-import",
    });
    event.target.value = "";
  }

  async function startCamera() {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      setCameraActive(true);
      requestAnimationFrame(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play();
      });
    } catch (cause) {
      setError(`Camera could not be opened: ${messageOf(cause)}`);
    }
  }

  function closeCamera() {
    stopCameraStream(streamRef.current);
    streamRef.current = undefined;
    setCameraActive(false);
  }

  async function captureCameraPhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setError("Camera preview is not ready yet.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera canvas is unavailable.");
    context.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    await savePhoto({
      name: `clinical-photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
      contentType: "image/jpeg",
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      source: "camera",
    });
  }

  async function savePhoto(file: {
    name: string;
    contentType: string;
    data: string;
    source: "camera" | "device-import";
  }) {
    if (!consented || !encounterReference || !structure.trim()) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await requestJson(
        `${clinicalGraphApiBase()}/clinical-graph/longitudinal-imaging`,
        {
          method: "POST",
          headers: { "Content-Type": "application/vnd.odos.longitudinal-imaging+json" },
          body: JSON.stringify({
            patientReference,
            encounterReference,
            structure,
            ...(definitionKey ? { procedureDefinitionStableKey: definitionKey } : {}),
            source: file.source,
            file: { name: file.name, contentType: file.contentType, data: file.data },
          }),
        },
      );
      setStatus(`${file.name} added to the ${structure} timeline.`);
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const priorPhoto = photos[photos.length - 1];
  const firstPhoto = photos.find((photo) => photo.mediaReference === firstReference);
  const secondPhoto = photos.find((photo) => photo.mediaReference === secondReference);
  const captureDisabled = busy || !consented || !encounterReference || !structure.trim();

  return (
    <section className="mt-8 rounded-xl border border-white/10 bg-bg-panel/80 p-5 text-white" aria-label="Longitudinal imaging">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-cyan-200/60">Clinical imaging</div>
          <h2 className="mt-1 text-xl font-semibold">Longitudinal photos</h2>
          <p className="mt-1 max-w-3xl text-sm text-white/50">One chart-level image record, viewed as sequential monitoring or an intentional two-image comparison.</p>
        </div>
        <div className="flex rounded-lg border border-white/10 bg-black/20 p-1" aria-label="Imaging lens">
          <LensButton active={lens === "timeline"} onClick={() => setLens("timeline")}>Timeline</LensButton>
          <LensButton active={lens === "compare"} onClick={() => setLens("compare")}>Compare</LensButton>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <label className="text-xs uppercase tracking-wider text-white/45">Procedure definition
          <select className="sidebar-input mt-2" value={definitionKey} onChange={(event) => setDefinitionKey(event.target.value)}>
            <option value="">General monitoring</option>
            {definitions.map((definition) => <option key={definition.stableKey} value={definition.stableKey}>{definition.display}</option>)}
          </select>
        </label>
        <label className="text-xs uppercase tracking-wider text-white/45">Structure / area
          <input
            className="sidebar-input mt-2"
            value={structureDraft}
            onChange={(event) => setStructureDraft(event.target.value)}
            onBlur={() => structureDraft.trim() && setStructure(structureDraft.trim())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && structureDraft.trim()) setStructure(structureDraft.trim());
            }}
          />
          <span className="mt-1 block normal-case tracking-normal text-white/30">Stored as native Media.bodySite free text.</span>
        </label>
        <label className="text-xs uppercase tracking-wider text-white/45">Visit
          <select className="sidebar-input mt-2" value={encounterReference} onChange={(event) => setEncounterReference(event.target.value)}>
            <option value="">Select a visit</option>
            {encounters.map((encounter) => <option key={encounter.reference} value={encounter.reference}>{encounter.label}</option>)}
          </select>
        </label>
      </div>

      {!consented && (
        <div className="mt-5 rounded-lg border border-amber-300/30 bg-amber-300/10 p-4">
          <div className="text-sm font-semibold text-amber-100">Photography consent required</div>
          <label className="mt-2 flex items-start gap-2 text-sm text-amber-50/80">
            <input type="checkbox" checked={consentAcknowledged} onChange={(event) => setConsentAcknowledged(event.target.checked)} />
            <span>The patient authorizes clinical photographs for care, longitudinal monitoring, and treatment comparison.</span>
          </label>
          <button className="sidebar-button mt-3" type="button" disabled={!consentAcknowledged || !encounterReference || busy} onClick={recordConsent}>Record consent</button>
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.15fr]">
        <div className="rounded-lg border border-white/10 bg-black/15 p-4">
          <h3 className="text-sm font-semibold">Capture or import</h3>
          <p className="mt-1 text-xs text-white/40">Device/file import is the primary eyecare path. Camera capture is available when consistent framing matters.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="sidebar-button" type="button" disabled={captureDisabled} onClick={() => fileRef.current?.click()}>Import image</button>
            <input ref={fileRef} className="sr-only" type="file" accept=".jpg,.jpeg,.png,.heic,image/jpeg,image/png,image/heic" onChange={importFile} />
            {!cameraActive
              ? <button className="sidebar-button" type="button" disabled={captureDisabled} onClick={startCamera}>Open camera</button>
              : <button className="sidebar-button" type="button" disabled={busy} onClick={closeCamera}>Close camera</button>}
          </div>
          {cameraActive && (
            <div className="mt-4">
              <CameraPreview videoRef={videoRef} priorPhoto={priorPhoto} />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-white/40">The prior {structure} image is overlaid to match angle and framing.</span>
                <button className="sidebar-button" type="button" disabled={busy} onClick={captureCameraPhoto}>Capture photo</button>
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 rounded-lg border border-white/10 bg-black/15 p-4">
          {loading && <p className="text-sm text-white/45">Loading image history…</p>}
          {!loading && lens === "timeline" && <PhotoTimeline photos={photos} />}
          {!loading && lens === "compare" && (
            <div>
              <div className="grid gap-2 sm:grid-cols-2">
                <PhotoSelect label="First image" photos={photos} value={firstReference} onChange={setFirstReference} />
                <PhotoSelect label="Second image" photos={photos} value={secondReference} onChange={setSecondReference} />
              </div>
              {suggestedPair && (
                <p className="mt-2 text-xs text-cyan-100/50">
                  Suggested from {suggestedPair.source === "series" ? "the first and latest image in this treatment series" : "the two most recent images"}.
                </p>
              )}
              <PhotoCompare first={firstPhoto} second={secondPhoto} />
            </div>
          )}
        </div>
      </div>

      {error && <div className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100" role="alert">{error}</div>}
      {status && <div className="mt-4 rounded border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100" role="status">{status}</div>}
    </section>
  );
}

export function CameraPreview({
  videoRef,
  priorPhoto,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  priorPhoto?: LongitudinalPhoto;
}) {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-cyan-200/20 bg-black" data-testid="camera-preview">
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {priorPhoto && (
        <img
          src={priorPhoto.dataUrl}
          alt={`Ghost overlay from ${formatPhotoDate(priorPhoto.recordedAt)}`}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35"
          data-testid="ghost-overlay"
        />
      )}
      <div className="pointer-events-none absolute inset-3 rounded border border-white/30" aria-hidden="true" />
    </div>
  );
}

export function PhotoTimeline({ photos }: { photos: readonly LongitudinalPhoto[] }) {
  if (photos.length === 0) return <p className="text-sm text-white/40">No images recorded for this structure.</p>;
  return (
    <div>
      <h3 className="text-sm font-semibold">{photos[0]!.structure} timeline</h3>
      <div className="mt-3 flex gap-3 overflow-x-auto pb-2" data-testid="photo-timeline">
        {photos.map((photo) => (
          <figure className="w-40 shrink-0" key={photo.mediaReference}>
            <img className="aspect-square w-full rounded-lg border border-white/10 object-cover" src={photo.dataUrl} alt={`${photo.structure} on ${formatPhotoDate(photo.recordedAt)}`} />
            <figcaption className="mt-2 text-xs text-white/45">{formatPhotoDate(photo.recordedAt)}{photo.seriesReference ? " · series" : ""}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

export function PhotoCompare({
  first,
  second,
}: {
  first?: LongitudinalPhoto;
  second?: LongitudinalPhoto;
}) {
  if (!first || !second) return <p className="mt-4 text-sm text-white/40">Choose two images to compare.</p>;
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="photo-compare">
      {[first, second].map((photo) => (
        <figure key={photo.mediaReference}>
          <img className="aspect-square w-full rounded-lg border border-white/10 object-cover" src={photo.dataUrl} alt={`${photo.structure} on ${formatPhotoDate(photo.recordedAt)}`} />
          <figcaption className="mt-2 text-xs text-white/45">{formatPhotoDate(photo.recordedAt)} · {photo.title}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function defaultLensForPhotoPosture(
  posture: "monitoring" | "showcase",
): ImagingLens {
  return posture === "showcase" ? "compare" : "timeline";
}

function LensButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) {
  return <button type="button" className={`rounded px-3 py-1.5 text-sm ${active ? "bg-cyan-300/20 text-cyan-100" : "text-white/45"}`} aria-pressed={active} onClick={onClick}>{children}</button>;
}

function PhotoSelect({
  label,
  photos,
  value,
  onChange,
}: {
  label: string;
  photos: readonly LongitudinalPhoto[];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label className="text-xs text-white/45">{label}
      <select className="sidebar-input mt-1" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose image</option>
        {photos.map((photo) => <option key={photo.mediaReference} value={photo.mediaReference}>{formatPhotoDate(photo.recordedAt)} · {photo.title}</option>)}
      </select>
    </label>
  );
}

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  const body = await response.json().catch(() => undefined) as (T & { error?: string }) | undefined;
  if (!response.ok) throw new Error(body?.error ?? `Clinical imaging request failed: ${response.status}`);
  if (!body) throw new Error("Clinical imaging request returned an invalid response.");
  return body;
}

function photoContentType(file: Pick<File, "name" | "type">): string | undefined {
  const declared = file.type.trim().toLowerCase();
  if (declared === "image/jpeg" || declared === "image/png" || declared === "image/heic") return declared;
  if (declared) return undefined;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "heic") return "image/heic";
  return undefined;
}

async function fileBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 8192) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function stopCameraStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function formatPhotoDate(value: string): string {
  if (!value) return "Date not recorded";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
