import { useRef, useState, type DragEvent } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

const ACCEPTED_FILE_TYPES = ".pdf,.bmp,.heic,.heif,.jpg,.jpeg,.png,.tif,.tiff,.webp";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const CATEGORY_OPTIONS = [
  ["visual-field", "Visual field printout"],
  ["fundus-photo", "Fundus photo"],
  ["anterior-segment-photo", "Anterior slit-lamp photo"],
  ["referral-scan", "Referral scan"],
  ["outside-record", "Outside record"],
  ["other", "Other imaging or document"],
] as const;

export function ImagingSection({ patientReference, encounterReference, onSaved }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORY_OPTIONS)[number][0]>("visual-field");
  const [interpretation, setInterpretation] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function chooseFile(next: File | undefined) {
    setSaved(null);
    setError(null);
    if (!next) return;
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
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/imaging`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/vnd.osod.manual-imaging+json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          category,
          ...(interpretation.trim() ? { interpretation: interpretation.trim() } : {}),
          file: {
            name: file.name,
            contentType: file.type || contentTypeFromName(file.name),
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
      onSaved({
        completed: true,
        summary,
        savedAt: new Date().toISOString(),
        operator: "OSOD UI manual imaging",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-4xl">
        <div>
          <h2 className="text-lg font-semibold text-white">Manual imaging scan-in</h2>
          <p className="mt-1 text-sm text-white/45">Upload external images and scanned documents without a device or DICOM connection.</p>
        </div>

        <div className="mt-6 rounded border border-white/10 bg-bg-panel/70 p-5">
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload imaging file"
            className={[
              "flex min-h-44 cursor-pointer flex-col items-center justify-center rounded border-2 border-dashed px-6 py-8 text-center transition",
              dragging ? "border-brand bg-brand/15" : "border-white/20 bg-bg-mid/50 hover:border-brand/60",
            ].join(" ")}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={dropFile}
          >
            <span className="text-base font-semibold text-white">Drop a scan or image here</span>
            <span className="mt-2 text-sm text-white/45">or choose a PDF, JPEG, PNG, TIFF, HEIC, BMP, or WebP file · 15 MB max</span>
            {file && <span className="mt-4 rounded bg-brand/15 px-3 py-2 text-sm text-brand-light">{file.name} · {formatBytes(file.size)}</span>}
          </div>
          <input
            ref={inputRef}
            aria-label="Choose imaging file"
            className="sr-only"
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <label className="text-sm text-white/65">
              Artifact type
              <select
                aria-label="Artifact type"
                className="sidebar-input mt-2"
                value={category}
                onChange={(event) => setCategory(event.target.value as typeof category)}
              >
                {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-sm text-white/65 lg:row-span-2">
              Interpretation (optional)
              <textarea
                aria-label="Interpretation (optional)"
                className="sidebar-input mt-2 min-h-32 resize-y"
                value={interpretation}
                maxLength={5000}
                onChange={(event) => setInterpretation(event.target.value)}
                placeholder="Enter findings only when this artifact is being interpreted now."
              />
              <span className="mt-1 block text-xs text-white/35">Creates a preliminary DiagnosticReport linked to the uploaded Media.</span>
            </label>
          </div>

          {error && <div role="alert" className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
          {saved && <div role="status" className="mt-4 rounded border border-emerald-400/40 bg-emerald-400/10 p-3 text-sm text-emerald-100">{saved}</div>}

          <button type="button" className="sidebar-button mt-5" disabled={!file || saving} onClick={upload}>
            {saving ? "Uploading…" : "Upload to chart"}
          </button>
        </div>
      </div>
    </section>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function contentTypeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "bmp") return "image/bmp";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  if (extension === "png") return "image/png";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

async function fileBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < buffer.length; offset += 8192) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
