import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Coverage, Encounter, Organization, Patient, Practitioner, PractitionerRole, RelatedPerson } from "@medplum/fhirtypes";
import { OdosSearchPicker, type OdosSearchPickerOption } from "../../components/inputs/OdosSearchPicker";
import { fhir } from "../../lib/fhir";
import { searchAll } from "../../lib/fhir-search";
import { patientName } from "../../lib/scheduler-appointment-ui";
import {
  addChargeLine,
  addDiagnosisLine,
  buildCoverageResource,
  buildProfessionalClaimInput,
  claimDraftFromProfessionalClaimInput,
  claimProviderFromPractitioner,
  claimPersonFromPatient,
  coverageIsSelf,
  coverageLabel,
  coveragePayerId,
  emptyPerson,
  initialClaimDraft,
  latestFinishedEncounter,
  loadEncounterClaimDraft,
  mergeProviderDefaults,
  previewStediClaimResubmission,
  removeChargeLine,
  removeDiagnosisLine,
  resolveSubscriberFromCoverage,
  submitProfessionalClaim,
  submitStediClaimResubmission,
  subscriberForClaim,
  subscriberFromCoverage,
  validateClaimDraft,
  type ChargeLine,
  type ClaimDraft,
  type ClaimMdPersonInput,
  type ClaimMdProviderInput,
  type CoverageEntryInput,
  type DiagnosisLine,
  type ProfessionalClaimChargeItemInput,
  type ProfessionalClaimInput,
  type SubmitClaimResult,
  type StediClaimResubmissionPreview,
  type StediPayerClassification,
} from "../../lib/submit-claims";
import { resolveWorklistItem } from "../../lib/claims-worklist";
import { PatientSearch } from "../PatientPicker";
import { loadBillingIdentityConfigSingleton } from "../settings/BillingIdentitySettings";
import type { BillingIdentityConfig } from "../settings/billing-identity-config";

type Step = "compose" | "review" | "success";
const ORGANIZATION_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/organization-type";
const PAYER_ORGANIZATION_TYPE_CODE = "pay";

export function SubmitClaims({
  initialEncounterId = "",
  initialSearch = "",
}: {
  initialEncounterId?: string;
  initialSearch?: string;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const resubmissionRoute = useMemo(() => parseResubmissionRoute(initialSearch), [initialSearch]);
  const [draft, setDraft] = useState<ClaimDraft>(() => initialClaimDraft(today));
  const [patient, setPatient] = useState<Patient>();
  const [choosingPatient, setChoosingPatient] = useState(true);
  const [coverages, setCoverages] = useState<Coverage[]>([]);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string>();
  const [payerName, setPayerName] = useState("");
  const [subscriberLoading, setSubscriberLoading] = useState(false);
  const [subscriberError, setSubscriberError] = useState<string>();
  const subscriberSelection = useRef(0);
  const [showCoverageEntry, setShowCoverageEntry] = useState(false);
  const [coverageEntry, setCoverageEntry] = useState<CoverageEntryInput>(() => emptyCoverageEntry(today));
  const [step, setStep] = useState<Step>("compose");
  const [reviewClaim, setReviewClaim] = useState<ProfessionalClaimInput>();
  const [errors, setErrors] = useState<string[]>([]);
  const [submissionError, setSubmissionError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitClaimResult>();
  const [encounterId, setEncounterId] = useState(initialEncounterId);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftLoadStatus, setDraftLoadStatus] = useState<string>();
  const [billingIdentity, setBillingIdentity] = useState<BillingIdentityConfig>();
  const [billingIdentityError, setBillingIdentityError] = useState<string>();
  const [resubmissionPreview, setResubmissionPreview] = useState<StediClaimResubmissionPreview>();
  const [payerClassification, setPayerClassification] = useState<"" | StediPayerClassification>(
    resubmissionRoute?.payerClassification ?? "",
  );
  const [successWarning, setSuccessWarning] = useState<string>();
  const liveErrors = useMemo(() => validateClaimDraft(draft), [draft]);

  useEffect(() => {
    let cancelled = false;
    loadBillingIdentityConfigSingleton(fhir)
      .then(({ config }) => {
        if (cancelled || !config) return;
        setBillingIdentity(config);
        setDraft((current) => ({
          ...current,
          billingProvider: mergeProviderDefaults(current.billingProvider, config),
        }));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBillingIdentityError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!resubmissionRoute) return;
    let cancelled = false;
    const api = claimApiOptions();
    previewStediClaimResubmission({
      originalClaimReference: resubmissionRoute.originalClaimReference,
      intent: "correct",
      ...(resubmissionRoute.payerClassification
        ? { payerClassification: resubmissionRoute.payerClassification }
        : {}),
    }, api)
      .then(async (preview) => {
        if (cancelled) return;
        setResubmissionPreview(preview);
        if (!preview.originalClaim) return;
        const nextDraft = claimDraftFromProfessionalClaimInput(preview.originalClaim, today);
        nextDraft.patientAccountNumber = resubmissionRoute.patientControlNumber;
        setDraft(nextDraft);
        const patientId = preview.originalClaim.patientReference.match(/^Patient\/([^/]+)$/)?.[1];
        const coverageId = preview.originalClaim.coverageReference.match(/^Coverage\/([^/]+)$/)?.[1];
        if (patientId) {
          const loadedPatient = await fhir.read<Patient>("Patient", patientId);
          if (!cancelled) {
            setPatient(loadedPatient);
            setChoosingPatient(false);
          }
        }
        if (coverageId) {
          const loadedCoverage = await fhir.read<Coverage>("Coverage", coverageId);
          const loadedPayerName = await coveragePayerName(loadedCoverage);
          if (!cancelled) {
            setCoverages([loadedCoverage]);
            setPayerName(loadedPayerName);
          }
        }
      })
      .catch((cause) => {
        if (!cancelled) setSubmissionError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [resubmissionRoute?.originalClaimReference]);

  useEffect(() => {
    const patientId = patient?.id;
    if (!patientId) return;
    let cancelled = false;
    async function loadCoverages() {
      setCoverageLoading(true);
      setCoverageError(undefined);
      try {
        const bundle = await fhir.search<Coverage>("Coverage", {
          beneficiary: `Patient/${patientId}`,
          _count: "50",
        });
        if (!cancelled) {
          const loadedCoverages = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
          setCoverages(loadedCoverages);
          const activeCoverages = loadedCoverages.filter((coverage) => coverage.status === "active");
          if (!draft.coverageReference && activeCoverages.length === 1 && patient) {
            void selectCoverageForPatient(activeCoverages[0], patient);
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setCoverageError(cause instanceof Error ? cause.message : String(cause));
          setCoverages([]);
        }
      } finally {
        if (!cancelled) setCoverageLoading(false);
      }
    }
    void loadCoverages();
    return () => {
      cancelled = true;
    };
  }, [patient?.id]);

  const selectPatient = (selected: Patient) => {
    if (!selected.id) return;
    setPatient(selected);
    setChoosingPatient(false);
    setCoverages([]);
    setShowCoverageEntry(false);
    setPayerName("");
    subscriberSelection.current += 1;
    setSubscriberError(undefined);
    setSubscriberLoading(false);
    setCoverageEntry(emptyCoverageEntry(today, `Patient/${selected.id}`));
    setDraft((current) => ({
      ...current,
      patientReference: `Patient/${selected.id}`,
      patient: claimPersonFromPatient(selected),
      subscriber: emptyPerson(),
      subscriberIsPatient: false,
      coverageReference: "",
      insurerReference: "",
    }));
    void loadLatestEncounterForPatient(selected);
  };

  const selectCoverage = (coverage: Coverage) => patient
    ? selectCoverageForPatient(coverage, patient)
    : Promise.resolve();

  async function selectCoverageForPatient(coverage: Coverage, selectedPatient: Patient): Promise<void> {
    if (!coverage.id) return;
    const selection = subscriberSelection.current + 1;
    subscriberSelection.current = selection;
    const coverageReference = `Coverage/${coverage.id}`;
    setSubscriberLoading(true);
    setSubscriberError(undefined);
    setDraft((current) => ({
      ...current,
      coverageReference,
      insurerReference: coverage.payor[0]?.reference ?? "",
      subscriber: subscriberFromCoverage(coverage, selectedPatient),
      subscriberIsPatient: coverageIsSelf(coverage),
    }));
    const [resolution, resolvedPayerName] = await Promise.all([
      resolveSubscriberFromCoverage(
        coverage,
        selectedPatient,
        (id) => fhir.read<RelatedPerson>("RelatedPerson", id),
      ),
      coveragePayerName(coverage),
    ]);
    if (subscriberSelection.current !== selection) return;
    setDraft((current) => current.coverageReference === coverageReference
      ? { ...current, subscriber: resolution.subscriber }
      : current);
    setSubscriberError(resolution.error);
    setPayerName(resolvedPayerName);
    setSubscriberLoading(false);
  }

  const createCoverage = async () => {
    const entryErrors = validateCoverageEntry(coverageEntry);
    if (entryErrors.length) {
      setCoverageError(entryErrors.join(" "));
      return;
    }
    setCoverageError(undefined);
    try {
      const created = await fhir.create(buildCoverageResource(coverageEntry), "submit-claims-coverage");
      setCoverages((current) => [created, ...current]);
      await selectCoverage(created);
      setShowCoverageEntry(false);
    } catch (cause) {
      setCoverageError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadFromEncounter = async (requestedEncounterId = encounterId.trim()) => {
    setDraftLoading(true);
    setDraftLoadStatus(undefined);
    try {
      setEncounterId(requestedEncounterId);
      const assembled = await loadEncounterClaimDraft(requestedEncounterId, {
        authorization: fhir.authHeader(),
        baseUrl: claimApiBaseUrl(),
      });
      if (!assembled.charges.length) {
        throw new Error(
          assembled.warnings?.join(" ") ?? "No billable ChargeItems are available for this encounter.",
        );
      }
      if (!assembled.diagnoses.length) throw new Error("No ranked confirmed diagnoses are available for this encounter.");
      const loadedPatient = await fhir.read<Patient>("Patient", assembled.patientReference.split("/")[1]!);
      let primaryCoverage: Coverage | undefined;
      let subscriber = emptyPerson();
      let subscriberResolutionError: string | undefined;
      let renderingDefaults: Awaited<ReturnType<typeof loadRenderingProviderDefaults>> = undefined;
      let renderingWarning: string | undefined;
      if (assembled.coverageReference) {
        primaryCoverage = await fhir.read<Coverage>("Coverage", assembled.coverageReference.split("/")[1]!);
        const resolution = await resolveSubscriberFromCoverage(
          primaryCoverage,
          loadedPatient,
          (id) => fhir.read<RelatedPerson>("RelatedPerson", id),
        );
        subscriber = resolution.subscriber;
        subscriberResolutionError = resolution.error;
      }
      try {
        renderingDefaults = await loadRenderingProviderDefaults(assembled.encounterReference);
      } catch (cause) {
        renderingWarning = `Rendering provider could not be prefilled: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      setPatient(loadedPatient);
      setChoosingPatient(false);
      setCoverages(primaryCoverage ? [primaryCoverage] : []);
      setPayerName(primaryCoverage ? await coveragePayerName(primaryCoverage) : "");
      setSubscriberError(subscriberResolutionError);
      setDraft((current) => ({
        ...current,
        patientReference: assembled.patientReference,
        patient: claimPersonFromPatient(loadedPatient),
        serviceDate: assembled.serviceDate || current.serviceDate,
        diagnoses: assembled.diagnoses,
        charges: assembled.charges,
        coverageReference: assembled.coverageReference ?? "",
        insurerReference: assembled.insurerReference ?? primaryCoverage?.payor[0]?.reference ?? "",
        payerId: assembled.payerId ?? (primaryCoverage ? coveragePayerId(primaryCoverage) : ""),
        subscriber,
        subscriberIsPatient: primaryCoverage ? coverageIsSelf(primaryCoverage) : false,
        ...(renderingDefaults ? {
          providerReference: renderingDefaults.providerReference,
          renderingProvider: renderingDefaults.provider,
        } : {}),
      }));
      setDraftLoadStatus([
        `Loaded ${assembled.diagnoses.length} diagnoses and ${assembled.charges.length} charges from ${assembled.encounterReference}.`,
        ...(assembled.warnings ?? []),
        ...(renderingWarning ? [renderingWarning] : []),
      ].join(" "));
    } catch (cause) {
      setDraftLoadStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDraftLoading(false);
    }
  };

  const loadLatestEncounterForPatient = async (selected: Patient) => {
    if (!selected.id) return;
    setDraftLoading(true);
    setDraftLoadStatus(undefined);
    try {
      const encounters = await searchAll<Encounter>(fhir, "Encounter", {
        subject: `Patient/${selected.id}`,
        status: "finished",
        _count: "100",
      });
      const latest = latestFinishedEncounter(encounters);
      if (latest?.id) {
        await loadFromEncounter(latest.id);
        return;
      }
      const renderingDefaults = await loadRenderingProviderDefaults();
      if (renderingDefaults) {
        setDraft((current) => ({
          ...current,
          providerReference: renderingDefaults.providerReference,
          renderingProvider: renderingDefaults.provider,
        }));
      }
      setDraftLoadStatus("No signed encounter was found for this patient. Enter claim lines manually.");
    } catch (cause) {
      setDraftLoadStatus(`Automatic encounter prefill was unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setDraftLoading(false);
    }
  };

  const loadRenderingProviderDefaults = async (encounterReference?: string) => {
    let practitionerReference: string | undefined;
    if (encounterReference) {
      const encounter = await fhir.read<Encounter>("Encounter", encounterReference.replace(/^Encounter\//, ""));
      const participantReference = encounter.participant
        ?.flatMap((participant) => participant.individual?.reference ? [participant.individual.reference] : [])
        .find((reference) => reference.startsWith("Practitioner/") || reference.startsWith("PractitionerRole/"));
      if (participantReference?.startsWith("Practitioner/")) {
        practitionerReference = participantReference;
      } else if (participantReference?.startsWith("PractitionerRole/")) {
        const role = await fhir.read<PractitionerRole>("PractitionerRole", participantReference.slice("PractitionerRole/".length));
        practitionerReference = role.practitioner?.reference;
      }
    }
    practitionerReference ??= fhir.practitionerId() ? `Practitioner/${fhir.practitionerId()}` : undefined;
    const match = practitionerReference?.match(/^Practitioner\/([^/]+)$/);
    if (!match) return undefined;
    const practitioner = await fhir.read<Practitioner>("Practitioner", match[1]);
    return {
      providerReference: practitionerReference!,
      provider: claimProviderFromPractitioner(practitioner),
    };
  };

  const openReview = () => {
    const nextErrors = validateClaimDraft(draft);
    if (resubmissionRoute && resubmissionPreview?.determination.status !== "ready") {
      nextErrors.unshift(resubmissionPreview?.determination.reason ?? "The Stedi correction path is not ready.");
    }
    setErrors(nextErrors);
    if (nextErrors.length) return;
    setReviewClaim(buildProfessionalClaimInput(draft));
    setSubmissionError(undefined);
    setStep("review");
    window.scrollTo({ top: 0 });
  };

  const claimSubscriber = subscriberForClaim(draft);

  const submit = async () => {
    if (!reviewClaim) return;
    setSubmitting(true);
    setSubmissionError(undefined);
    try {
      const api = claimApiOptions();
      const submitted = resubmissionRoute
        ? await submitStediClaimResubmission({
            originalClaimReference: resubmissionRoute.originalClaimReference,
            intent: "correct",
            patientControlNumber: reviewClaim.patientAccountNumber,
            revisedClaim: reviewClaim,
            ...(payerClassification ? { payerClassification } : {}),
          }, api)
        : await submitProfessionalClaim(reviewClaim, api);
      setResult(submitted);
      setStep("success");
      if (resubmissionRoute?.taskId && submitted.claimReference) {
        try {
          await resolveWorklistItem(resubmissionRoute.taskId, {
            disposition: "rebilled",
            claimReference: submitted.claimReference,
          }, api);
        } catch (cause) {
          setSuccessWarning(`The correction was submitted, but the worklist item still needs resolution: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    } catch (cause) {
      setSubmissionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const startAnother = () => {
    const next = initialClaimDraft(today);
    setDraft(billingIdentity ? { ...next, billingProvider: mergeProviderDefaults(next.billingProvider, billingIdentity) } : next);
    setPatient(undefined);
    setChoosingPatient(true);
    setCoverages([]);
    setPayerName("");
    setCoverageEntry(emptyCoverageEntry(today));
    subscriberSelection.current += 1;
    setSubscriberError(undefined);
    setSubscriberLoading(false);
    setReviewClaim(undefined);
    setErrors([]);
    setSubmissionError(undefined);
    setResult(undefined);
    setEncounterId("");
    setDraftLoadStatus(undefined);
    setStep("compose");
  };

  return (
    <main className="min-h-screen bg-bg-deep px-5 py-6 text-white">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Claims management</p>
            <h1 className="text-2xl font-semibold">{resubmissionRoute ? "Correct Stedi claim" : "Compose and submit claim"}</h1>
            <p className="mt-1 text-sm text-white/50">Single professional claim · configured clearinghouse</p>
          </div>
          <ol className="flex gap-2 text-xs font-bold uppercase tracking-wide text-white/40">
            <StepLabel active={step === "compose"} value="1 Compose" />
            <StepLabel active={step === "review"} value="2 Review" />
            <StepLabel active={step === "success"} value="3 Result" />
          </ol>
        </header>

        {step === "compose" && (
          <div className="space-y-5">
            {resubmissionRoute && (
              <StediCorrectionBanner
                preview={resubmissionPreview}
                payerClassification={payerClassification}
                onPayerClassification={async (value) => {
                  setPayerClassification(value);
                  try {
                    setResubmissionPreview(await previewStediClaimResubmission({
                      originalClaimReference: resubmissionRoute.originalClaimReference,
                      intent: "correct",
                      ...(value ? { payerClassification: value } : {}),
                    }, claimApiOptions()));
                  } catch (cause) {
                    setSubmissionError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              />
            )}
            {submissionError && <SubmissionAlert message={submissionError} />}
            <Section title="Encounter prefill" description="Load ranked diagnoses, billable charges, and primary Coverage from a signed encounter. Review and edit before submitting.">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[18rem] flex-1"><Field label="Encounter ID" value={encounterId} placeholder="Encounter resource id" onChange={setEncounterId} /></div>
                <button type="button" onClick={() => void loadFromEncounter()} disabled={draftLoading || !encounterId.trim()} className="rounded bg-brand px-4 py-2 text-sm font-semibold disabled:opacity-50">{draftLoading ? "Loading…" : "Load from encounter"}</button>
              </div>
              {draftLoadStatus && <p role="status" className="mt-3 text-sm text-[color:var(--odos-muted)]">{draftLoadStatus}</p>}
            </Section>
            <Section title="Patient" description="Select the patient whose demographics should prefill this claim.">
              {patient && !choosingPatient ? (
                <div className="flex items-center justify-between rounded-md border border-blue-400/30 bg-blue-950/20 p-4">
                  <div>
                    <div className="font-semibold">{patientName(patient)}</div>
                    <div className="mt-1 text-xs text-white/45">{draft.patientReference} · DOB {patient.birthDate ?? "manual entry required"}</div>
                  </div>
                  <button type="button" onClick={() => setChoosingPatient(true)} className="rounded border border-white/15 px-3 py-2 text-sm text-white/70">Change</button>
                </div>
              ) : (
                <PatientSearch onSelect={selectPatient} />
              )}
            </Section>

            {patient && !choosingPatient && (
              <>
                <Section title="Coverage" description="Existing Coverages are loaded by beneficiary. Create the minimum policy record when needed.">
                  {coverageError && <SubmissionAlert message={coverageError} />}
                  {coverageLoading ? (
                    <p className="text-sm text-white/45">Loading Coverage records…</p>
                  ) : (
                    <div className="space-y-2">
                      <CoverageChoices
                        coverages={coverages}
                        selectedReference={draft.coverageReference}
                        onSelect={selectCoverage}
                      />
                      {coverages.length === 0 && <p className="text-sm text-white/45">No Coverage records found for this patient.</p>}
                    </div>
                  )}
                  <InlineErrors errors={claimErrors(liveErrors, "Select a Coverage.", "The selected Coverage")} />
                  <button type="button" onClick={() => setShowCoverageEntry((value) => !value)} className="mt-3 rounded bg-blue-700 px-3 py-2 text-sm font-semibold">
                    {showCoverageEntry ? "Cancel Coverage entry" : "Add Coverage"}
                  </button>
                  {showCoverageEntry && (
                    <div className="mt-4 grid gap-3 rounded border border-white/10 bg-black/20 p-4 md:grid-cols-2">
                      <OdosSearchPicker
                        label="Payor organization"
                        value={coverageEntry.payorReference}
                        selectedLabel={coverageEntry.payorDisplay}
                        placeholder="Search payer name"
                        search={searchPayerOrganizations}
                        onSelect={(option) => setCoverageEntry((current) => ({
                          ...current,
                          payorReference: option.value,
                          payorDisplay: option.label,
                        }))}
                        onClear={() => setCoverageEntry((current) => ({
                          ...current,
                          payorReference: "",
                          payorDisplay: "",
                        }))}
                        onCreate={createPayerOrganization}
                        createLabel="Create payer"
                      />
                      <Field label="Member ID" value={coverageEntry.memberId} onChange={(value) => setCoverageEntry((current) => ({ ...current, memberId: value }))} />
                      <Field label="Group number (optional)" value={coverageEntry.groupNumber} onChange={(value) => setCoverageEntry((current) => ({ ...current, groupNumber: value }))} />
                      <SelectField label="Relationship" value={coverageEntry.relationship} options={[{ value: "self", label: "Subscriber is patient" }, { value: "other", label: "Other subscriber" }]} onChange={(value) => setCoverageEntry((current) => ({ ...current, relationship: value as "self" | "other" }))} />
                      <Field label="Effective date" type="date" value={coverageEntry.effectiveDate} onChange={(value) => setCoverageEntry((current) => ({ ...current, effectiveDate: value }))} />
                      <button type="button" onClick={() => void createCoverage()} className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold md:col-span-2">Create and select Coverage</button>
                    </div>
                  )}
                </Section>

                <Section title="Claim details" description="FHIR references and clearinghouse identifiers for this submission.">
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    <OdosSearchPicker
                      label="Rendering provider"
                      value={draft.providerReference}
                      selectedLabel={providerDisplay(draft.renderingProvider)}
                      placeholder="Search practitioner name"
                      search={searchPractitioners}
                      onSelect={(option) => setDraft((current) => ({
                        ...current,
                        providerReference: option.value,
                        renderingProvider: claimProviderFromPractitioner(option.item),
                      }))}
                      onClear={() => setDraft((current) => ({ ...current, providerReference: "" }))}
                      validationMessage={claimError(liveErrors, "FHIR provider reference")}
                    />
                    <Field label="Payer ID" value={draft.payerId} error={claimError(liveErrors, "Payer ID")} onChange={(value) => setDraft((current) => ({ ...current, payerId: value }))} />
                    <Field label="Patient account number" value={draft.patientAccountNumber} error={claimError(liveErrors, "Patient account number")} onChange={(value) => setDraft((current) => ({ ...current, patientAccountNumber: value }))} />
                    <Field label="Service date" type="date" value={draft.serviceDate} error={claimError(liveErrors, "Service date")} onChange={(value) => setDraft((current) => ({ ...current, serviceDate: value }))} />
                    <Field label="Created date" type="date" value={draft.created} error={claimError(liveErrors, "Created date")} onChange={(value) => setDraft((current) => ({ ...current, created: value }))} />
                    <ReadOnlyField label="Insurer reference" value={draft.insurerReference || "Select Coverage"} error={claimError(liveErrors, "The selected Coverage")} />
                  </div>
                </Section>

                <Section title="Billing provider" description="Prefilled from the practice billing identity when configured; editable for this claim.">
                  {billingIdentityError && <div className="mb-3"><SubmissionAlert message={`Billing identity defaults unavailable: ${billingIdentityError}`} /></div>}
                  <ProviderFields provider={draft.billingProvider} errorPrefix="Billing provider" errors={liveErrors} onChange={(billingProvider) => setDraft((current) => ({ ...current, billingProvider }))} />
                </Section>

                <Section title="Rendering provider" description="NPI and either last name or organization name are required.">
                  <ProviderFields provider={draft.renderingProvider} errorPrefix="Rendering provider" errors={liveErrors} onChange={(renderingProvider) => setDraft((current) => ({ ...current, renderingProvider }))} />
                </Section>

                <Section title="Patient demographics" description="Available FHIR Patient fields are prefilled and remain editable when the stored record is incomplete.">
                  <PersonFields person={draft.patient} errorPrefix="Patient" errors={liveErrors} onChange={(next) => setDraft((current) => ({ ...current, patient: next }))} />
                </Section>

                <Section title="Subscriber demographics" description={draft.subscriberIsPatient ? "Self relationship: copied from the selected patient." : "Other relationship: stored subscriber demographics are prefilled and remain editable."}>
                  {subscriberError && <div className="mb-3"><SubmissionAlert message={subscriberError} /></div>}
                  {subscriberLoading && <p className="mb-3 text-sm text-white/45">Loading subscriber record…</p>}
                  {draft.subscriberIsPatient ? (
                    <>
                      <PersonSummary person={claimSubscriber} />
                      <InlineErrors errors={claimErrors(liveErrors, "Subscriber relationship")} />
                    </>
                  ) : (
                    <PersonFields person={draft.subscriber} errorPrefix="Subscriber" errors={liveErrors} includePolicy onChange={(next) => setDraft((current) => ({ ...current, subscriber: next }))} />
                  )}
                </Section>

                <Section title="Diagnoses" description="Prefilled from the signed encounter when available; confirm, reorder, or enter manually when needed.">
                  <DiagnosisLines lines={draft.diagnoses} errors={liveErrors} onChange={(diagnoses) => setDraft((current) => ({ ...current, diagnoses }))} />
                </Section>

                <Section title="Charges" description="Prefilled from billable encounter ChargeItems when available; manual entry remains available for no-encounter claims.">
                  <ChargeLines lines={draft.charges} errors={liveErrors} onChange={(charges) => setDraft((current) => ({ ...current, charges }))} />
                </Section>

                {errors.length > 0 && <SubmissionAlert message={errors.join(" ")} />}
                <div className="flex justify-end">
                  <button type="button" onClick={openReview} className="rounded bg-blue-600 px-5 py-3 font-semibold">Review claim</button>
                </div>
              </>
            )}
          </div>
        )}

        {step === "review" && reviewClaim && (
          <div className="space-y-4">
            {resubmissionRoute && <StediCorrectionBanner preview={resubmissionPreview} payerClassification={payerClassification} />}
            <ClaimReview
              claim={reviewClaim}
              payerName={payerName}
              error={submissionError}
              submitting={submitting}
              onEdit={() => setStep("compose")}
              onSubmit={() => void submit()}
            />
          </div>
        )}

        {step === "success" && result && (
          <div className="space-y-4">
            {successWarning && <SubmissionAlert message={successWarning} />}
            <ClaimSubmissionResult result={result} onAnother={startAnother} />
          </div>
        )}
      </div>
    </main>
  );
}

export function SubmissionAlert({ message }: { message: string }) {
  return <div role="alert" className="rounded border border-red-400/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{message}</div>;
}

function StediCorrectionBanner({
  preview,
  payerClassification,
  onPayerClassification,
}: {
  preview?: StediClaimResubmissionPreview;
  payerClassification: "" | StediPayerClassification;
  onPayerClassification?: (value: "" | StediPayerClassification) => void | Promise<void>;
}) {
  const determination = preview?.determination;
  return (
    <section className="rounded-lg border border-blue-400/30 bg-blue-950/20 p-4">
      <h2 className="font-semibold text-blue-100">Stedi corrected claim</h2>
      <p className="mt-1 text-xs text-[color:var(--odos-muted)]">ODOS uses a payer ClaimResponse PCCN to distinguish pre-adjudication from adjudication. Payer names are never used to infer Medicare.</p>
      {onPayerClassification && (
        <label className="mt-3 block max-w-md text-xs font-semibold text-[color:var(--odos-text)]">
          Payer classification
          <select value={payerClassification} onChange={(event) => void onPayerClassification(event.target.value as "" | StediPayerClassification)} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-deep-surface)] px-3 py-2 text-sm text-[color:var(--odos-text)]">
            <option value="">Not confirmed</option>
            <option value="confirmed-non-medicare">Confirmed not Original Medicare</option>
            <option value="original-medicare">Original Medicare Part A/B</option>
          </select>
        </label>
      )}
      {!determination && <p className="mt-3 text-sm text-[color:var(--odos-muted)]">Checking CFC and PCCN…</p>}
      {determination?.status === "manual" && <p className="mt-3 text-sm text-amber-300">Manual handling required: {determination.reason}</p>}
      {determination?.status === "ready" && (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="Claim frequency code" value={determination.claimFrequencyCode} />
          <Detail label="Payer claim control number" value={determination.claimControlNumber ?? "Not included"} />
        </dl>
      )}
    </section>
  );
}

export function CoverageChoices({
  coverages,
  selectedReference,
  onSelect,
}: {
  coverages: readonly Coverage[];
  selectedReference: string;
  onSelect: (coverage: Coverage) => void | Promise<void>;
}) {
  return coverages.map((coverage) => (
    <label key={coverage.id} className="flex cursor-pointer items-start gap-3 rounded border border-white/10 bg-black/20 p-3">
      <input
        type="radio"
        name="coverage"
        checked={`Coverage/${coverage.id}` === selectedReference}
        onChange={() => onSelect(coverage)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-semibold text-white/80">{coverageLabel(coverage)}</span>
        <span className="mt-1 block text-xs text-white/40">{coverage.period?.start ?? "No effective date"} · {coverageIsSelf(coverage) ? "Subscriber is patient" : "Other subscriber"}</span>
      </span>
    </label>
  ));
}

export function ClaimSubmissionResult({ result, onAnother }: { result: SubmitClaimResult; onAnother: () => void }) {
  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-950/20 p-6">
      <p className="text-xs font-bold uppercase tracking-wide text-emerald-300">Submitted</p>
      <h2 className="mt-1 text-xl font-semibold">Claim accepted for clearinghouse submission</h2>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <Detail label="FHIR Claim ID" value={result.claimId ?? "Not returned"} />
        <Detail label="Clearinghouse" value={result.clearinghouse === "stedi" ? "Stedi" : "Claim.MD"} />
        <Detail label="Status" value={result.status ?? "Not returned"} />
        <Detail label="Clearinghouse claim ID" value={result.claimMdClaimId ?? result.stediCorrelationId ?? "Not returned"} />
        <Detail label="Tracking number" value={result.claimMdTrackingNumber ?? result.stediTrackingNumber ?? "Not returned"} />
      </dl>
      <button type="button" onClick={onAnother} className="mt-6 rounded bg-emerald-700 px-4 py-2 font-semibold">Compose another claim</button>
    </section>
  );
}

export function ClaimReview({
  claim,
  payerName,
  error,
  submitting,
  onEdit,
  onSubmit,
}: {
  claim: ProfessionalClaimInput;
  payerName?: string;
  error?: string;
  submitting: boolean;
  onEdit: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Review assembled claim</h2>
          <p className="mt-1 text-sm text-[color:var(--odos-faint)]">Confirm the people, payer, diagnoses, charges, and total before submission.</p>
        </div>
        <button type="button" onClick={onEdit} disabled={submitting} className="rounded border border-white/15 px-3 py-2 text-sm text-white/70 disabled:opacity-50">Back to edit</button>
      </div>
      <div className="mt-5 space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <ReviewGroup title="Patient">
            <PersonSummary person={claim.patient} />
          </ReviewGroup>
          <ReviewGroup title="Subscriber">
            <PersonSummary person={claim.subscriber} />
          </ReviewGroup>
          <ReviewGroup title="Payer">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Name" value={payerName || "Name unavailable"} />
              <Detail label="Payer ID" value={claim.payerId} />
            </dl>
          </ReviewGroup>
          <ReviewGroup title="Providers">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Billing provider" value={providerDisplay(claim.billingProvider) || "Name unavailable"} />
              <Detail label="Rendering provider" value={providerDisplay(claim.renderingProvider) || "Name unavailable"} />
            </dl>
          </ReviewGroup>
        </div>
        <ReviewGroup title="Diagnoses">
          <ol className="space-y-2">
            {claim.diagnoses.map((diagnosis, index) => (
              <li key={`${diagnosis.system}:${diagnosis.code}:${index}`} className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] px-3 py-2 text-sm">
                <span className="font-semibold text-[color:var(--odos-text)]">{index + 1}. {diagnosis.code}</span>
                <span className="ml-2 text-[color:var(--odos-muted)]">{diagnosis.display || "No description"}</span>
              </li>
            ))}
          </ol>
        </ReviewGroup>
        <ReviewGroup title="Charges">
          <div className="space-y-2">
            {claim.chargeItems.map((charge, index) => {
              const coding = charge.code.coding?.[0];
              return (
                <div key={charge.id ?? index} className="grid gap-2 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] px-3 py-2 text-sm sm:grid-cols-[1fr_auto_auto]">
                  <div>
                    <span className="font-semibold text-[color:var(--odos-text)]">{coding?.code ?? "Missing code"}</span>
                    <span className="ml-2 text-[color:var(--odos-muted)]">{coding?.display ?? charge.code.text ?? "No description"}</span>
                  </div>
                  <div className="text-[color:var(--odos-muted)]">Fee {formatClaimMoney(Number(charge.priceOverride?.value ?? 0))} · Qty {charge.quantity?.value ?? 1}</div>
                  <div className="font-semibold text-[color:var(--odos-text)]">{formatClaimMoney(chargeLineTotal(charge))}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end border-t border-[color:var(--odos-line)] pt-4 text-lg font-semibold">
            Claim total&nbsp;<span className="text-emerald-300">{formatClaimMoney(claimTotal(claim))}</span>
          </div>
        </ReviewGroup>
      </div>
      {error && <div className="mt-4"><SubmissionAlert message={error} /></div>}
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onSubmit} disabled={submitting} className="rounded bg-emerald-700 px-5 py-3 font-semibold disabled:opacity-50">{submitting ? "Submitting…" : "Submit claim"}</button>
      </div>
    </section>
  );
}

function ReviewGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--odos-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-bg-panel/80 p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-white/45">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StepLabel({ active, value }: { active: boolean; value: string }) {
  return <li className={active ? "rounded bg-blue-500/20 px-2 py-1 text-blue-200" : "px-2 py-1"}>{value}</li>;
}

function Field({ label, value, onChange, placeholder, type = "text", inputMode, error }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; inputMode?: "decimal" | "numeric"; error?: string }) {
  return (
    <label className="block text-xs font-semibold text-white/60">
      {label}
      <input type={type} inputMode={inputMode} value={value} placeholder={placeholder} aria-invalid={error ? true : undefined} onChange={(event) => onChange(event.target.value)} className={`mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 ${inputMode ? "min-h-11" : ""}`} />
      {error && <span className="mt-1 block font-normal text-red-300">{error}</span>}
    </label>
  );
}

function ReadOnlyField({ label, value, error }: { label: string; value: string; error?: string }) {
  return <div className="text-xs font-semibold text-white/60"><div>{label}</div><div className="mt-1 min-h-9 rounded border border-white/10 bg-black/20 px-3 py-2 text-sm font-normal text-white/55">{value}</div>{error && <div className="mt-1 font-normal text-red-300">{error}</div>}</div>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <label className="block text-xs font-semibold text-white/60">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white">
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ProviderFields({ provider, onChange, errorPrefix, errors = [] }: { provider: ClaimMdProviderInput; onChange: (provider: ClaimMdProviderInput) => void; errorPrefix?: string; errors?: readonly string[] }) {
  const set = (key: keyof ClaimMdProviderInput, value: string) => onChange({ ...provider, [key]: value });
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Field label="Organization/name" value={provider.name ?? ""} onChange={(value) => set("name", value)} />
        <Field label="First name" value={provider.firstName ?? ""} onChange={(value) => set("firstName", value)} />
        <Field label="Last name" value={provider.lastName ?? ""} onChange={(value) => set("lastName", value)} />
        <Field label="NPI" value={provider.npi} error={errorPrefix ? claimError(errors, `${errorPrefix} NPI`) : undefined} onChange={(value) => set("npi", value)} />
        <Field label="Tax ID" value={provider.taxId ?? ""} onChange={(value) => set("taxId", value)} />
        <SelectField label="Tax ID type" value={provider.taxIdType ?? "E"} options={[{ value: "E", label: "EIN" }, { value: "S", label: "SSN" }]} onChange={(value) => set("taxIdType", value)} />
        <Field label="Taxonomy" value={provider.taxonomy ?? ""} onChange={(value) => set("taxonomy", value)} />
        <Field label="Address" value={provider.address1 ?? ""} onChange={(value) => set("address1", value)} />
        <Field label="City" value={provider.city ?? ""} onChange={(value) => set("city", value)} />
        <Field label="State" value={provider.state ?? ""} onChange={(value) => set("state", value)} />
        <Field label="ZIP" value={provider.zip ?? ""} onChange={(value) => set("zip", value)} />
        <Field label="Phone" value={provider.phone ?? ""} onChange={(value) => set("phone", value)} />
        <Field label="Email" value={provider.email ?? ""} onChange={(value) => set("email", value)} />
        <Field label="Fax" value={provider.fax ?? ""} onChange={(value) => set("fax", value)} />
      </div>
      {errorPrefix && <InlineErrors errors={claimErrors(errors, `${errorPrefix} phone`, `${errorPrefix} last name`)} />}
    </div>
  );
}

export function PersonFields({ person, onChange, includePolicy = false, errorPrefix, errors = [] }: { person: ClaimMdPersonInput; onChange: (person: ClaimMdPersonInput) => void; includePolicy?: boolean; errorPrefix?: string; errors?: readonly string[] }) {
  const set = (key: keyof ClaimMdPersonInput, value: string) => onChange({ ...person, [key]: value });
  const error = (field: string) => errorPrefix ? claimError(errors, `${errorPrefix} ${field}`) : undefined;
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Field label="First name" value={person.firstName} error={error("first name")} onChange={(value) => set("firstName", value)} />
      <Field label="Middle name" value={person.middleName ?? ""} onChange={(value) => set("middleName", value)} />
      <Field label="Last name" value={person.lastName} error={error("last name")} onChange={(value) => set("lastName", value)} />
      <Field label="Date of birth" type="date" value={person.dateOfBirth} error={error("date of birth")} onChange={(value) => set("dateOfBirth", value)} />
      <SelectField label="Sex" value={person.sex} options={[{ value: "M", label: "Male" }, { value: "F", label: "Female" }, { value: "U", label: "Unknown/other" }]} onChange={(value) => set("sex", value)} />
      <Field label="Address" value={person.address1 ?? ""} error={error("address")} onChange={(value) => set("address1", value)} />
      <Field label="City" value={person.city ?? ""} error={error("city")} onChange={(value) => set("city", value)} />
      <Field label="State" value={person.state ?? ""} error={error("state")} onChange={(value) => set("state", value)} />
      <Field label="ZIP" value={person.zip ?? ""} error={error("ZIP")} onChange={(value) => set("zip", value)} />
      {includePolicy && <Field label="Member ID" value={person.memberId ?? ""} onChange={(value) => set("memberId", value)} />}
      {includePolicy && <Field label="Group number" value={person.groupNumber ?? ""} onChange={(value) => set("groupNumber", value)} />}
      {includePolicy && <Field label="Subscriber relationship code" value={person.relationshipCode ?? ""} error={error("relationship code")} onChange={(value) => set("relationshipCode", value)} />}
    </div>
  );
}

function PersonSummary({ person }: { person: ClaimMdPersonInput }) {
  const address = [
    person.address1,
    [person.city, person.state].filter(Boolean).join(", "),
    person.zip,
  ].filter(Boolean).join(" ");
  return (
    <dl className="grid gap-3 text-sm md:grid-cols-2">
      <Detail label="Name" value={[person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ") || "Missing"} />
      <Detail label="DOB / sex" value={`${person.dateOfBirth || "Missing"} · ${person.sex}`} />
      <Detail label="Address" value={address || "Missing"} />
      <Detail label="Member / group" value={`${person.memberId ?? "Missing"} · ${person.groupNumber ?? "Missing"}`} />
    </dl>
  );
}

function DiagnosisLines({ lines, onChange, errors }: { lines: DiagnosisLine[]; onChange: (lines: DiagnosisLine[]) => void; errors: readonly string[] }) {
  const update = (index: number, value: DiagnosisLine) => onChange(lines.map((line, candidate) => candidate === index ? value : line));
  return (
    <div className="space-y-3">
      {lines.map((line, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[4rem_1fr_2fr_auto] md:items-end">
          <ReadOnlyField label="Line" value={String(index + 1)} />
          <Field label="ICD-10 code" value={line.code} error={claimError(errors, `Diagnosis ${index + 1} code`)} onChange={(code) => update(index, { ...line, code })} />
          <Field label="Description" value={line.description} onChange={(description) => update(index, { ...line, description })} />
          <button type="button" disabled={lines.length === 1} onClick={() => onChange(removeDiagnosisLine(lines, index))} className="rounded border border-white/15 px-3 py-2 text-sm text-white/60 disabled:opacity-30">Remove</button>
        </div>
      ))}
      <InlineErrors errors={claimErrors(errors, "At least one diagnosis")} />
      <button type="button" onClick={() => onChange(addDiagnosisLine(lines))} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Add diagnosis</button>
    </div>
  );
}

export function ChargeLines({ lines, onChange, errors }: { lines: ChargeLine[]; onChange: (lines: ChargeLine[]) => void; errors: readonly string[] }) {
  const update = (index: number, value: ChargeLine) => onChange(lines.map((line, candidate) => candidate === index ? value : line));
  return (
    <div className="space-y-3">
      {lines.map((line, index) => (
        <div key={line.id ?? index}>
          <div className="grid gap-2 md:grid-cols-[8rem_1fr_2fr_8rem_6rem_auto] md:items-end">
            <SelectField label="Code set" value={line.codeType} options={[{ value: "CPT", label: "CPT" }, { value: "HCPCS", label: "HCPCS" }]} onChange={(codeType) => update(index, { ...line, codeType: codeType as "CPT" | "HCPCS" })} />
            <Field label="Code" value={line.code} error={claimError(errors, `Charge ${index + 1} code`)} onChange={(code) => update(index, { ...line, code })} />
            <Field label="Description" value={line.description} onChange={(description) => update(index, { ...line, description })} />
            <Field label="Line total (USD)" value={line.feeDollars} placeholder="125.50" inputMode="decimal" error={claimError(errors, `Charge ${index + 1} fee`)} onChange={(feeDollars) => update(index, { ...line, feeDollars })} />
            <Field label="Quantity" type="number" inputMode="numeric" value={line.quantity} error={claimError(errors, `Charge ${index + 1} quantity`)} onChange={(quantity) => update(index, { ...line, quantity })} />
            <button type="button" disabled={lines.length === 1} onClick={() => onChange(removeChargeLine(lines, index))} className="rounded border border-white/15 px-3 py-2 text-sm text-white/60 disabled:opacity-30">Remove</button>
          </div>
          {line.id && <div className="mt-1 text-xs text-[color:var(--odos-muted)]">ChargeItem/{line.id} · diagnoses {line.diagnosisSequence?.join(", ") || "none"}{line.laterality ? ` · ${line.laterality}` : ""}</div>}
          <InlineErrors errors={claimErrors(errors, `Charge ${index + 1} must`, `Charge ${index + 1} may`, `Charge ${index + 1} diagnosis`)} />
        </div>
      ))}
      <InlineErrors errors={claimErrors(errors, "At least one charge")} />
      <button type="button" onClick={() => onChange(addChargeLine(lines))} className="rounded border border-blue-400/30 px-3 py-2 text-sm text-blue-200">Add charge</button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-white/40">{label}</dt><dd className="mt-1 break-all font-semibold text-white/75">{value}</dd></div>;
}

function claimError(errors: readonly string[], ...prefixes: string[]): string | undefined {
  return errors.find((error) => prefixes.some((prefix) => error.startsWith(prefix)));
}

function claimErrors(errors: readonly string[], ...prefixes: string[]): string[] {
  return errors.filter((error) => prefixes.some((prefix) => error.startsWith(prefix)));
}

function InlineErrors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-red-300">
      {errors.map((error) => <li key={error}>{error}</li>)}
    </ul>
  );
}

function emptyCoverageEntry(today: string, patientReference = ""): CoverageEntryInput {
  return { patientReference, payorReference: "", payorDisplay: "", memberId: "", groupNumber: "", relationship: "self", effectiveDate: today };
}

export function validateCoverageEntry(entry: CoverageEntryInput): string[] {
  const errors: string[] = [];
  if (!entry.patientReference) errors.push("Select a patient before creating Coverage.");
  if (!/^Organization\/[^/]+$/.test(entry.payorReference.trim())) errors.push("Payor must be an Organization reference such as Organization/123.");
  if (!entry.memberId.trim()) errors.push("Member ID is required.");
  if (!entry.effectiveDate) errors.push("Effective date is required.");
  return errors;
}

export async function searchPayerOrganizations(query: string): Promise<OdosSearchPickerOption<Organization>[]> {
  const bundle = await fhir.search<Organization>("Organization", {
    name: query,
    type: `${ORGANIZATION_TYPE_SYSTEM}|${PAYER_ORGANIZATION_TYPE_CODE}`,
    _count: "20",
  });
  return (bundle.entry ?? [])
    .flatMap((entry) => entry.resource?.id && entry.resource.name ? [entry.resource] : [])
    .filter((organization) => organization.active !== false)
    .map(organizationPickerOption);
}

export async function createPayerOrganization(name: string): Promise<OdosSearchPickerOption<Organization>> {
  const organization = await fhir.create<Organization>(
    {
      resourceType: "Organization",
      name,
      type: [{
        coding: [{
          system: ORGANIZATION_TYPE_SYSTEM,
          code: PAYER_ORGANIZATION_TYPE_CODE,
          display: "Payer",
        }],
      }],
    },
    "submit-claims-payer",
  );
  if (!organization.id) throw new Error("The payer Organization was created without an id.");
  return organizationPickerOption(organization);
}

function organizationPickerOption(organization: Organization): OdosSearchPickerOption<Organization> {
  return {
    value: `Organization/${organization.id}`,
    label: organization.name!,
    description: `Organization/${organization.id}`,
    item: organization,
  };
}

async function searchPractitioners(query: string): Promise<OdosSearchPickerOption<Practitioner>[]> {
  const bundle = await fhir.search<Practitioner>("Practitioner", { name: query, _count: "20" });
  return (bundle.entry ?? [])
    .flatMap((entry) => entry.resource?.id ? [entry.resource] : [])
    .filter((practitioner) => practitioner.active !== false)
    .map((practitioner) => ({
      value: `Practitioner/${practitioner.id}`,
      label: practitionerDisplay(practitioner),
      description: claimProviderFromPractitioner(practitioner).npi
        ? `NPI ${claimProviderFromPractitioner(practitioner).npi}`
        : `Practitioner/${practitioner.id}`,
      item: practitioner,
    }));
}

export function practitionerDisplay(practitioner: Practitioner): string {
  const provider = claimProviderFromPractitioner(practitioner);
  return [provider.firstName, provider.lastName].filter(Boolean).join(" ") || `Practitioner/${practitioner.id}`;
}

function providerDisplay(provider: ClaimMdProviderInput): string {
  return provider.name?.trim()
    || [provider.firstName?.trim(), provider.lastName?.trim()].filter(Boolean).join(" ");
}

async function coveragePayerName(coverage: Coverage): Promise<string> {
  const payor = coverage.payor[0];
  if (payor?.display?.trim()) return payor.display.trim();
  const organizationId = payor?.reference?.match(/^Organization\/([^/]+)$/)?.[1];
  if (!organizationId) return "";
  try {
    return (await fhir.read<Organization>("Organization", organizationId)).name?.trim() ?? "";
  } catch {
    return "";
  }
}

function chargeLineTotal(charge: ProfessionalClaimChargeItemInput): number {
  return Number(charge.priceOverride?.value ?? 0);
}

function claimTotal(claim: ProfessionalClaimInput): number {
  return claim.chargeItems.reduce((total, charge) => total + chargeLineTotal(charge), 0);
}

function formatClaimMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function claimApiBaseUrl(): string {
  const meta = import.meta as ImportMeta & { env?: { VITE_ODOS_MCP_BASE_URL?: string } };
  return meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}

function claimApiOptions() {
  return { authorization: fhir.authHeader(), baseUrl: claimApiBaseUrl() };
}

function parseResubmissionRoute(search: string): {
  originalClaimReference: string;
  patientControlNumber: string;
  taskId?: string;
  payerClassification?: StediPayerClassification;
} | undefined {
  const params = new URLSearchParams(search);
  const originalClaimReference = params.get("originalClaim") ?? "";
  if (params.get("intent") !== "correct" || !/^Claim\/[A-Za-z0-9.-]+$/.test(originalClaimReference)) return undefined;
  const payerClassification = params.get("payerClassification");
  return {
    originalClaimReference,
    patientControlNumber: params.get("patientControlNumber") ?? "",
    ...(params.get("task") ? { taskId: params.get("task")! } : {}),
    ...(payerClassification === "confirmed-non-medicare" || payerClassification === "original-medicare"
      ? { payerClassification }
      : {}),
  };
}
