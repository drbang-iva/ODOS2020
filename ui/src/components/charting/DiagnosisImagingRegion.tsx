import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import {
  loadDiagnosisImagingOpen,
  saveDiagnosisImagingOpen,
} from "../../lib/diagnosis-workspace-preferences";
import type { ImagingSummary } from "./ImagingSection";

interface Props {
  patientReference: string;
}

interface ImagingPayload {
  images?: ImagingSummary[];
  error?: string;
}

export function DiagnosisImagingRegion({ patientReference }: Props) {
  const [open, setOpen] = useState(loadDiagnosisImagingOpen);
  const [images, setImages] = useState<ImagingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference });
    setLoading(true);
    setError(undefined);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/imaging?${query}`, {
      headers: authHeaders(),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as ImagingPayload;
      if (!response.ok) throw new Error(body.error ?? `Imaging history failed: ${response.status}`);
      return body.images ?? [];
    }).then(setImages).catch((caught) => {
      if ((caught as Error).name !== "AbortError") {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [patientReference]);

  function toggle() {
    const next = !open;
    setOpen(next);
    saveDiagnosisImagingOpen(next);
  }

  return (
    <aside className={`odos-diagnosis-imaging${open ? " is-open" : ""}`} aria-label="Imaging">
      <button
        type="button"
        className="odos-diagnosis-imaging-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>Imaging</span>
        <span aria-hidden>{open ? "›" : "‹"}</span>
      </button>
      {open && (
        <div className="odos-diagnosis-imaging-content">
          {loading && <p className="odos-diagnosis-muted">Loading imaging…</p>}
          {error && <p role="alert" className="odos-diagnosis-error">{error}</p>}
          {!loading && !error && images.length === 0 && (
            <p className="odos-diagnosis-muted">No imaging on file.</p>
          )}
          {images.map((image) => (
            <article key={image.id} className="odos-diagnosis-imaging-card">
              {image.contentState === "available" && image.contentUrl && image.contentType.startsWith("image/") ? (
                <img src={image.contentUrl} alt={image.title} />
              ) : image.contentState === "available" && image.contentUrl ? (
                <a href={image.contentUrl} target="_blank" rel="noreferrer">Open {image.title}</a>
              ) : (
                <div className="odos-diagnosis-imaging-missing">Preview unavailable</div>
              )}
              <div>
                <strong>{image.title}</strong>
                <small>{image.date}{image.laterality ? ` · ${image.laterality}` : ""}</small>
              </div>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
