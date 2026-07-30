import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { OdosWheel } from "../inputs/OdosWheel";
import type { CustomFindingDefinition } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type Lid = "upper" | "lower";
type ScoringSystem = "meiboscore" | "arita";

interface Props {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
  apiBase?: string;
}

interface MeibographyRow {
  observationReference?: string;
  documentReference?: string;
  imageUrl?: string;
  imageUnavailable?: boolean;
  recordedAt: string;
  eye?: string;
  lid?: string;
  score?: number;
  scoringSystem?: ScoringSystem;
  contentType?: string;
  data?: string;
  title?: string;
  dropoutGrade?: string;
}

interface PendingUpload {
  documentReference: string;
  eye: Eye;
  lid: Lid;
}

interface GradeHistoryRow {
  eye?: Eye;
  values: Array<{ code: string; value: number | string }>;
}

export function DryEyeGlandStructureSection({
  definition,
  patientReference,
  encounterReference,
  onSaved,
  apiBase,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [eye, setEye] = useState<Eye>("OD");
  const [lid, setLid] = useState<Lid>("upper");
  const [scoringSystem, setScoringSystem] = useState<ScoringSystem>("meiboscore");
  const [totalScore, setTotalScore] = useState("");
  const [dropoutGrade, setDropoutGrade] = useState("");
  const [rows, setRows] = useState<MeibographyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingImage, setLoadingImage] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const base = apiBase ?? clinicalGraphApiBase();
  const dropoutField = definition.customFields.find(
    (field) => field.localCode === "CUSTOM_DROPOUT_GRADE",
  );

  async function loadHistory(signal?: AbortSignal) {
    setError(null);
    const patientQuery = new URLSearchParams({ patient: patientReference });
    const [imageResponse, gradeResponse] = await Promise.all([
      fetch(
        `${base}/clinical-graph/dry-eye/meibography?${patientQuery}`,
        { headers: authHeaders(), signal },
      ),
      fetch(
        `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${patientQuery}`,
        { headers: authHeaders(), signal },
      ),
    ]);
    const imageBody = await imageResponse.json() as {
      rows?: MeibographyRow[];
      error?: string;
    };
    const gradeBody = await gradeResponse.json() as {
      rows?: GradeHistoryRow[];
      error?: string;
    };
    if (!imageResponse.ok) {
      throw new Error(
        imageBody.error ?? `Meibography history failed: ${imageResponse.status}`,
      );
    }
    if (!gradeResponse.ok) {
      throw new Error(
        gradeBody.error ?? `Meibography grade history failed: ${gradeResponse.status}`,
      );
    }
    const gradeByImage = new Map(
      (gradeBody.rows ?? []).flatMap((row) => {
        const imageReference = row.values.find(
          (value) => value.code === "CUSTOM_IMAGE_REFERENCE",
        )?.value;
        const gradeCode = row.values.find(
          (value) => value.code === "CUSTOM_DROPOUT_GRADE",
        )?.value;
        if (typeof imageReference !== "string" || typeof gradeCode !== "string") {
          return [];
        }
        const grade = dropoutField?.options?.find(
          (option) => option.code === gradeCode,
        )?.display ?? gradeCode;
        return [[imageReference, grade] as const];
      }),
    );
    setRows((imageBody.rows ?? []).map((row) => ({
      ...row,
      ...(row.documentReference && gradeByImage.has(row.documentReference)
        ? { dropoutGrade: gradeByImage.get(row.documentReference) }
        : {}),
    })));
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadHistory(controller.signal)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [patientReference, base]);

  async function loadImage(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row?.imageUrl) return;
    setLoadingImage(row.documentReference ?? row.imageUrl);
    setError(null);
    try {
      const response = await fetch(`${base}${row.imageUrl}`, {
        headers: authHeaders(),
      });
      const body = await response.json() as {
        contentType?: string;
        data?: string;
        title?: string;
        error?: string;
      };
      if (!response.ok || !body.contentType || !body.data) {
        throw new Error(body.error ?? `Meibography image failed: ${response.status}`);
      }
      setRows((current) => current.map((candidate, index) =>
        index === rowIndex
          ? {
              ...candidate,
              contentType: body.contentType,
              data: body.data,
              title: body.title ?? candidate.title,
            }
          : candidate
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingImage(null);
    }
  }

  async function save() {
    if (!dropoutGrade || (!pendingUpload && (!file || !totalScore.trim()))) {
      setError("Choose an image, enter a score, and select a dropout grade.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      let upload = pendingUpload;
      if (!upload) {
        const captureFile = file!;
        const response = await fetch(`${base}/clinical-graph/dry-eye/meibography`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            patientReference,
            encounterReference,
            eye,
            lid,
            scoringSystem,
            totalScore: Number(totalScore),
            file: {
              name: captureFile.name,
              contentType: captureFile.type || contentTypeFromName(captureFile.name),
              data: await fileBase64(captureFile),
            },
          }),
        });
        const body = await response.json() as {
          documentReference?: { id?: string };
          error?: string;
        };
        const documentReference = body.documentReference?.id
          ? `DocumentReference/${body.documentReference.id}`
          : undefined;
        if (!response.ok || !documentReference) {
          throw new Error(body.error ?? `Meibography capture failed: ${response.status}`);
        }
        upload = { documentReference, eye, lid };
        setPendingUpload(upload);
      }
      const gradeResponse = await fetch(
        `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            patientReference,
            encounterReference,
            eyes: {
              [upload.eye]: {
                customFields: [
                  {
                    code: "CUSTOM_IMAGE_REFERENCE",
                    value: upload.documentReference,
                  },
                  { code: "CUSTOM_DROPOUT_GRADE", value: dropoutGrade },
                ],
              },
            },
          }),
        },
      );
      const gradeBody = await gradeResponse.json() as { error?: string };
      if (!gradeResponse.ok) {
        throw new Error(
          gradeBody.error ??
            `Meibography image saved; retry the dropout grade: ${gradeResponse.status}`,
        );
      }
      await loadHistory();
      setMessage(`${upload.eye} ${upload.lid} lid meibography and dropout grade saved.`);
      setPendingUpload(null);
      setFile(null);
      setTotalScore("");
      setDropoutGrade("");
      if (inputRef.current) inputRef.current.value = "";
      onSaved({
        completed: true,
        summary: `${upload.eye} ${upload.lid} lid captured`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI dry-eye meibography",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const maximumScore = scoringSystem === "meiboscore" ? 9 : 15;
  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <div className="border-b border-[color:var(--odos-line)] pb-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">
            Dry Eye Workup
          </div>
          <h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">Gland Structure</h2>
          <p className="mt-1 text-sm text-[color:var(--odos-faint)]">
            The image and score use the existing meibography Observation pathway.
            Dropout grading remains explicitly provisional.
          </p>
          {pendingUpload && (
            <p className="mt-2 text-sm text-amber-200">
              Image saved for {pendingUpload.eye} {pendingUpload.lid} lid. Retry the grade without re-uploading.
            </p>
          )}
        </div>
        <div className="mt-5 grid gap-4 rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-5 md:grid-cols-2 xl:grid-cols-5">
          <label className="text-sm text-[color:var(--odos-muted)]">
            Eye
            <select aria-label="Meibography eye" value={eye} onChange={(event) => setEye(event.target.value as Eye)} className="sidebar-input mt-2">
              <option value="OD">OD</option>
              <option value="OS">OS</option>
            </select>
          </label>
          <label className="text-sm text-[color:var(--odos-muted)]">
            Lid
            <select aria-label="Meibography lid" value={lid} onChange={(event) => setLid(event.target.value as Lid)} className="sidebar-input mt-2">
              <option value="upper">Upper</option>
              <option value="lower">Lower</option>
            </select>
          </label>
          <label className="text-sm text-[color:var(--odos-muted)]">
            Scoring system
            <select aria-label="Meibography scoring system" value={scoringSystem} onChange={(event) => setScoringSystem(event.target.value as ScoringSystem)} className="sidebar-input mt-2">
              <option value="meiboscore">Meiboscore</option>
              <option value="arita">Arita</option>
            </select>
          </label>
          <label className="text-sm text-[color:var(--odos-muted)]">
            Total score
            <div className="mt-2">
              <OdosWheel
                ariaLabel="Meibography total score"
                value={totalScore === "" ? 0 : Number(totalScore)}
                centerOn={0}
                min={0}
                max={maximumScore}
                step={1}
                format={String}
                onChange={(value) => setTotalScore(String(value))}
                states={[{ value: "", label: "Not recorded" }]}
                selectedState={totalScore === "" ? "" : undefined}
                onStateChange={setTotalScore}
              />
            </div>
          </label>
          <label className="text-sm text-[color:var(--odos-muted)]">
            Dropout grade (grading scheme provisional)
            <select aria-label="Dropout grade" value={dropoutGrade} onChange={(event) => setDropoutGrade(event.target.value)} className="sidebar-input mt-2">
              <option value="">Select</option>
              {(dropoutField?.options ?? []).filter((option) => option.active).map((option) => (
                <option key={option.code} value={option.code}>{option.display}</option>
              ))}
            </select>
          </label>
          <label className="text-sm text-[color:var(--odos-muted)] md:col-span-2 xl:col-span-4">
            Meibography image
            <input
              ref={inputRef}
              aria-label="Meibography image"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const nextFile = event.target.files?.[0] ?? null;
                setFile(nextFile);
                if (nextFile) setPendingUpload(null);
              }}
              className="sidebar-input mt-2"
            />
          </label>
          <button type="button" onClick={save} disabled={saving} className="sidebar-button self-end">
            {saving
              ? "Saving…"
              : pendingUpload
                ? "Retry grade"
                : "Save image + grade"}
          </button>
        </div>
        {error && <div role="alert" className="mt-4 rounded border border-red-400/35 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        {message && <div role="status" className="mt-4 rounded border border-emerald-400/35 bg-emerald-400/10 p-3 text-sm text-emerald-100">{message}</div>}
        <div className="mt-6 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55">
          <div className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm font-semibold text-[color:var(--odos-text)]">History</div>
          {loading && <div className="p-6 text-sm text-[color:var(--odos-faint)]">Loading meibography…</div>}
          {!loading && rows.length === 0 && <div className="p-6 text-sm text-[color:var(--odos-faint)]">No prior meibography</div>}
          {!loading && rows.length > 0 && (
            <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((row, index) => (
                <article key={row.observationReference ?? `${row.recordedAt}-${index}`} className="rounded border border-[color:var(--odos-line)] bg-bg-deep/60 p-3">
                  {row.data && row.contentType && <img src={`data:${row.contentType};base64,${row.data}`} alt={row.title ?? "Meibography"} className="aspect-video w-full rounded object-cover" />}
                  {!row.data && row.imageUrl && (
                    <button
                      type="button"
                      onClick={() => void loadImage(index)}
                      disabled={loadingImage === (row.documentReference ?? row.imageUrl)}
                      className="sidebar-button w-full"
                    >
                      {loadingImage === (row.documentReference ?? row.imageUrl)
                        ? "Loading image…"
                        : "Load image"}
                    </button>
                  )}
                  {!row.data && row.imageUnavailable && (
                    <div className="rounded border border-amber-300/20 bg-amber-300/5 p-3 text-xs text-amber-100">
                      Image unavailable; score metadata retained.
                    </div>
                  )}
                  <div className="mt-3 text-sm font-semibold text-[color:var(--odos-text)]">{row.eye} {row.lid} lid · score {row.score}</div>
                  {row.dropoutGrade && <div className="mt-1 text-xs text-[color:var(--odos-muted)]">{row.dropoutGrade}</div>}
                  <div className="mt-1 text-xs text-[color:var(--odos-faint)]">{row.scoringSystem} · {formatDate(row.recordedAt)}</div>
                  <div className="mt-1 break-all text-[10px] text-[color:var(--odos-faint)]">{row.documentReference}</div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function contentTypeFromName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  return "image/octet-stream";
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
