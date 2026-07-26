import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
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

  async function save() {
    if (!file || !dropoutGrade || !totalScore.trim()) {
      setError("Choose an image, enter a score, and select a dropout grade.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
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
            name: file.name,
            contentType: file.type || contentTypeFromName(file.name),
            data: await fileBase64(file),
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
      const gradeResponse = await fetch(
        `${base}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            patientReference,
            encounterReference,
            eyes: {
              [eye]: {
                customFields: [
                  { code: "CUSTOM_IMAGE_REFERENCE", value: documentReference },
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
            `Meibography image saved, but dropout grade failed: ${gradeResponse.status}`,
        );
      }
      await loadHistory();
      setMessage(`${eye} ${lid} lid meibography and dropout grade saved.`);
      setFile(null);
      setTotalScore("");
      setDropoutGrade("");
      if (inputRef.current) inputRef.current.value = "";
      onSaved({
        completed: true,
        summary: `${eye} ${lid} lid captured`,
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
        <div className="border-b border-white/10 pb-4">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">
            Dry Eye Workup
          </div>
          <h2 className="mt-1 text-xl font-semibold text-white">Gland Structure</h2>
          <p className="mt-1 text-sm text-white/45">
            The image and score use the existing meibography Observation pathway.
            Dropout grading remains explicitly provisional.
          </p>
        </div>
        <div className="mt-5 grid gap-4 rounded border border-white/10 bg-bg-panel/65 p-5 md:grid-cols-2 xl:grid-cols-5">
          <label className="text-sm text-white/65">
            Eye
            <select aria-label="Meibography eye" value={eye} onChange={(event) => setEye(event.target.value as Eye)} className="sidebar-input mt-2">
              <option value="OD">OD</option>
              <option value="OS">OS</option>
            </select>
          </label>
          <label className="text-sm text-white/65">
            Lid
            <select aria-label="Meibography lid" value={lid} onChange={(event) => setLid(event.target.value as Lid)} className="sidebar-input mt-2">
              <option value="upper">Upper</option>
              <option value="lower">Lower</option>
            </select>
          </label>
          <label className="text-sm text-white/65">
            Scoring system
            <select aria-label="Meibography scoring system" value={scoringSystem} onChange={(event) => setScoringSystem(event.target.value as ScoringSystem)} className="sidebar-input mt-2">
              <option value="meiboscore">Meiboscore</option>
              <option value="arita">Arita</option>
            </select>
          </label>
          <label className="text-sm text-white/65">
            Total score
            <input aria-label="Meibography total score" type="number" min={0} max={maximumScore} step={1} value={totalScore} onChange={(event) => setTotalScore(event.target.value)} className="sidebar-input mt-2" />
          </label>
          <label className="text-sm text-white/65">
            Dropout grade (grading scheme provisional)
            <select aria-label="Dropout grade" value={dropoutGrade} onChange={(event) => setDropoutGrade(event.target.value)} className="sidebar-input mt-2">
              <option value="">Select</option>
              {(dropoutField?.options ?? []).filter((option) => option.active).map((option) => (
                <option key={option.code} value={option.code}>{option.display}</option>
              ))}
            </select>
          </label>
          <label className="text-sm text-white/65 md:col-span-2 xl:col-span-4">
            Meibography image
            <input
              ref={inputRef}
              aria-label="Meibography image"
              type="file"
              accept="image/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="sidebar-input mt-2"
            />
          </label>
          <button type="button" onClick={save} disabled={saving} className="sidebar-button self-end">
            {saving ? "Saving…" : "Save image + grade"}
          </button>
        </div>
        {error && <div role="alert" className="mt-4 rounded border border-red-400/35 bg-red-400/10 p-3 text-sm text-red-100">{error}</div>}
        {message && <div role="status" className="mt-4 rounded border border-emerald-400/35 bg-emerald-400/10 p-3 text-sm text-emerald-100">{message}</div>}
        <div className="mt-6 overflow-hidden rounded border border-white/10 bg-bg-panel/55">
          <div className="border-b border-white/10 px-4 py-3 text-sm font-semibold text-white">History</div>
          {loading && <div className="p-6 text-sm text-white/45">Loading meibography…</div>}
          {!loading && rows.length === 0 && <div className="p-6 text-sm text-white/45">No prior meibography</div>}
          {!loading && rows.length > 0 && (
            <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {rows.map((row, index) => (
                <article key={row.observationReference ?? `${row.recordedAt}-${index}`} className="rounded border border-white/10 bg-bg-deep/60 p-3">
                  {row.data && row.contentType && <img src={`data:${row.contentType};base64,${row.data}`} alt={row.title ?? "Meibography"} className="aspect-video w-full rounded object-cover" />}
                  <div className="mt-3 text-sm font-semibold text-white">{row.eye} {row.lid} lid · score {row.score}</div>
                  {row.dropoutGrade && <div className="mt-1 text-xs text-white/65">{row.dropoutGrade}</div>}
                  <div className="mt-1 text-xs text-white/45">{row.scoringSystem} · {formatDate(row.recordedAt)}</div>
                  <div className="mt-1 break-all text-[10px] text-white/30">{row.documentReference}</div>
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
