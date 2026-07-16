import { useEffect, useState } from "react";
import type { Questionnaire } from "@medplum/fhirtypes";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

export function AestheticsConsentSection({
  patientReference,
  encounterReference,
  onSaved,
  apiBase,
}: {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
  apiBase?: string;
}) {
  const [questionnaire, setQuestionnaire] = useState<Questionnaire>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<SectionSaveStatus>();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase ?? clinicalGraphApiBase()}/clinical-graph/aesthetics-consent`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as { questionnaire?: Questionnaire; error?: string };
        if (!response.ok || !body.questionnaire) {
          throw new Error(body.error ?? `Consent definition failed: ${response.status}`);
        }
        setQuestionnaire(body.questionnaire);
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => controller.abort();
  }, [apiBase]);

  async function submit() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`${apiBase ?? clinicalGraphApiBase()}/clinical-graph/aesthetics-consent`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          acknowledged,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Consent submission failed: ${response.status}`);
      const status = {
        completed: true,
        summary: "Cosmetic consent acknowledged",
        savedAt: new Date().toISOString(),
        operator: "OSOD UI aesthetics consent",
      };
      setSaved(status);
      onSaved(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const acknowledgement = questionnaire?.item?.find((item) => item.type === "boolean");
  const notice = questionnaire?.item?.find((item) => item.type === "display");

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl">
        <div className="border-b border-white/10 pb-4">
          <h2 className="text-lg font-semibold text-white">{questionnaire?.title ?? "Cosmetic procedure consent"}</h2>
          <p className="mt-1 text-sm text-white/45">FHIR QuestionnaireResponse on the shared patient record</p>
        </div>
        {notice?.text && (
          <div className="mt-5 rounded border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
            {notice.text}
          </div>
        )}
        {acknowledgement?.text && (
          <label className="mt-5 flex items-start gap-3 rounded border border-white/10 bg-white/[0.02] p-4 text-sm text-white/75">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand"
            />
            <span>{acknowledgement.text}</span>
          </label>
        )}
        <div className="mt-5 flex items-center justify-between gap-3">
          <div>
            {error && <div className="text-sm text-rose-300">{error}</div>}
            {saved && !error && <div className="text-sm text-white/65">{saved.summary}</div>}
          </div>
          <button
            type="button"
            disabled={!acknowledged || saving}
            onClick={submit}
            className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Submit consent"}
          </button>
        </div>
      </div>
    </section>
  );
}
