import type { Patient } from "@medplum/fhirtypes";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { acknowledgeOfficeMessage, fetchClinicOfficeMessages, type OfficeMessage } from "../lib/office-channel";
import { fetchClinicSummary, type ClinicSummary } from "../lib/clinic-summary";
import { fhir } from "../lib/fhir";
import { patientName } from "../lib/scheduler-appointment-ui";
import { patientOverviewView, useViewState } from "../lib/view-state";
import { CLINIC_PATH } from "../scenes/DeskHome";

export interface OfficeInboxApi {
  list: typeof fetchClinicOfficeMessages;
  acknowledge: typeof acknowledgeOfficeMessage;
}

export interface OfficeChannelState {
  messages: OfficeMessage[];
  unread: OfficeMessage[];
  open: boolean;
  setOpen(open: boolean): void;
  error?: string;
  acknowledging?: string;
  acknowledge(messageId: string): Promise<void>;
  refresh(): Promise<void>;
}

const defaultApi: OfficeInboxApi = { list: fetchClinicOfficeMessages, acknowledge: acknowledgeOfficeMessage };
const emptyState: OfficeChannelState = {
  messages: [], unread: [], open: false, setOpen: () => undefined,
  acknowledge: async () => undefined, refresh: async () => undefined,
};
const OfficeChannelContext = createContext<OfficeChannelState | undefined>(undefined);
const ClinicSummaryContext = createContext<{ summary?: ClinicSummary; error?: string } | undefined>(undefined);

export function useOfficeChannel(): OfficeChannelState {
  return useContext(OfficeChannelContext) ?? emptyState;
}

export function useClinicSummaryContext() {
  return useContext(ClinicSummaryContext);
}

export function useOfficeInbox(options: { initialMessages?: OfficeMessage[]; pollMs?: number; api?: OfficeInboxApi } = {}): OfficeChannelState {
  const api = options.api ?? defaultApi;
  const [messages, setMessages] = useState(options.initialMessages ?? []);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [acknowledging, setAcknowledging] = useState<string>();
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await api.list();
      if (requestId !== requestIdRef.current) return;
      setMessages(next);
      setError(undefined);
    } catch (reason) {
      if (requestId === requestIdRef.current) setError(reason instanceof Error ? reason.message : "Office channel unavailable.");
    }
  }, [api]);

  useEffect(() => {
    if (options.initialMessages || typeof window === "undefined") return;
    void refresh();
    const handle = window.setInterval(() => void refresh(), options.pollMs ?? 15_000);
    return () => {
      window.clearInterval(handle);
      requestIdRef.current += 1;
    };
  }, [options.initialMessages, options.pollMs, refresh]);

  async function acknowledge(messageId: string) {
    if (acknowledging) return;
    requestIdRef.current += 1;
    setAcknowledging(messageId);
    try {
      const updated = await api.acknowledge(messageId);
      setMessages((current) => current.map((message) => message.id === messageId ? updated : message));
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Office acknowledgement failed.");
    } finally {
      setAcknowledging(undefined);
    }
  }

  const unread = useMemo(() => messages.filter((message) => !message.acknowledgement), [messages]);
  return { messages, unread, open, setOpen, error, acknowledging, acknowledge, refresh };
}

export function ClinicOfficeShell({
  children,
  initialMessages,
  officeApi,
  pollMs = 15_000,
  initialSummary,
}: {
  children: ReactNode;
  initialMessages?: OfficeMessage[];
  officeApi?: OfficeInboxApi;
  pollMs?: number;
  initialSummary?: ClinicSummary;
}) {
  const office = useOfficeInbox({ initialMessages, pollMs, api: officeApi });
  const [summary, setSummary] = useState(initialSummary);
  const [summaryError, setSummaryError] = useState<string>();

  useEffect(() => {
    if (initialSummary) return;
    let active = true;
    fetchClinicSummary()
      .then((value) => active && setSummary(value))
      .catch((reason) => active && setSummaryError(reason instanceof Error ? reason.message : "Clinic summary unavailable."));
    return () => { active = false; };
  }, [initialSummary]);

  const summaryState = useMemo(() => ({ summary, error: summaryError }), [summary, summaryError]);

  return (
    <ClinicSummaryContext.Provider value={summaryState}>
      <OfficeChannelContext.Provider value={office}>
        {children}
      </OfficeChannelContext.Provider>
    </ClinicSummaryContext.Provider>
  );
}

export function ClinicPatientSearch() {
  const setView = useViewState((state) => state.setView);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setPatients([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    let active = true;
    const handle = window.setTimeout(() => {
      setLoading(true);
      searchClinicPatients(trimmed)
        .then((results) => { if (active) { setPatients(results); setError(undefined); } })
        .catch((reason) => { if (active) { setPatients([]); setError(reason instanceof Error ? reason.message : "Patient search unavailable."); } })
        .finally(() => active && setLoading(false));
    }, 250);
    return () => { active = false; window.clearTimeout(handle); };
  }, [query]);

  function selectPatient(patient: Patient) {
    if (!patient.id) return;
    setQuery("");
    setOpen(false);
    navigateTo(`${CLINIC_PATH}?patientId=${encodeURIComponent(patient.id)}`);
    setView(patientOverviewView(patient.id));
  }

  return (
    <div className={`odos-clinic-search !order-none !basis-auto min-w-[240px]${open ? " is-open" : ""}`}>
      <span className="odos-clinic-search-glass" aria-hidden>⌕</span>
      <input
        ref={inputRef}
        value={query}
        aria-label="Find a patient"
        aria-expanded={open && Boolean(query.trim())}
        placeholder="Find a patient — name, DOB, chart #"
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 180)}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
      />
      <span className="odos-clinic-search-kbd">⌘K</span>
      {open && query.trim() && (
        <div className="odos-clinic-search-pop" role="listbox" aria-label="Patient search results">
          {loading && <div className="odos-clinic-search-state">Searching…</div>}
          {error && <div className="odos-clinic-search-state is-error">Patient search unavailable</div>}
          {!loading && !error && patients.length === 0 && <div className="odos-clinic-search-state">No matching patients</div>}
          {!loading && !error && patients.map((patient) => (
            <button key={patient.id} type="button" role="option" disabled={!patient.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectPatient(patient)}>
              <span>{patientName(patient)}</span>
              <small>DOB {patient.birthDate ?? "unknown"}</small>
              <i>chart {shortId(patient.id)}</i>
            </button>
          ))}
          <a className="odos-clinic-search-new" href="/patient/new" onMouseDown={(event) => event.preventDefault()} onClick={navigateWithinApp}>＋ New patient…</a>
        </div>
      )}
    </div>
  );
}

export async function searchClinicPatients(query: string, api: Pick<typeof fhir, "search"> = fhir): Promise<Patient[]> {
  const birthDate = normalizedBirthDate(query);
  const bundles = birthDate
    ? [await api.search<Patient>("Patient", { birthdate: birthDate, _count: "8" })]
    : await Promise.all([
        api.search<Patient>("Patient", { name: query, _count: "8" }),
        api.search<Patient>("Patient", { identifier: query.replace(/^#/, ""), _count: "8" }),
        ...(isFhirId(query.replace(/^#/, "")) ? [api.search<Patient>("Patient", { _id: query.replace(/^#/, ""), _count: "8" })] : []),
      ]);
  const seen = new Set<string>();
  return bundles.flatMap((bundle) => (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []))
    .filter((patient) => patient.id && !seen.has(patient.id) && Boolean(seen.add(patient.id)))
    .slice(0, 8);
}

function normalizedBirthDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function isFhirId(value: string): boolean {
  return /^[A-Za-z0-9.-]{1,64}$/.test(value);
}

function shortId(value: string | undefined): string {
  if (!value) return "pending";
  return value.length <= 8 ? value : value.slice(0, 8);
}

export function OfficePill({ count, open, onClick }: { count: number; open: boolean; onClick(): void }) {
  return <button className="odos-pill odos-office-pill" type="button" aria-expanded={open} onClick={onClick}>Office {count > 0 && <span className="odos-office-badge">{count}</span>}</button>;
}

export function OfficeInboxPanel({ messages, error, acknowledging, onAcknowledge, onClose }: { messages: OfficeMessage[]; error?: string; acknowledging?: string; onAcknowledge(id: string): Promise<void>; onClose(): void }) {
  return (
    <aside className="odos-office-panel" aria-label="Office messages">
      <div className="odos-office-panel-head"><div><strong>Office</strong><span>Internal clinic channel</span></div><button type="button" onClick={onClose} aria-label="Close Office messages">×</button></div>
      {error && <p role="alert" className="odos-office-error">{error}</p>}
      {messages.length === 0 && !error && <p className="odos-office-empty">No Office messages.</p>}
      {messages.map((message) => <OfficeMessageCard key={message.id} message={message} acknowledging={acknowledging === message.id} onAcknowledge={onAcknowledge} />)}
    </aside>
  );
}

export function UrgentOfficeBanner({ messages, acknowledging, onAcknowledge }: { messages: OfficeMessage[]; acknowledging?: string; onAcknowledge(id: string): Promise<void> }) {
  const message = messages[0];
  if (!message) return null;
  return (
    <div className="odos-office-nudge" role="status" aria-label={`${messages.length} urgent Office message${messages.length === 1 ? "" : "s"}`}>
      <div className="odos-office-nudge-inner">
        <span className="odos-office-from">Front desk · {message.sender.display}</span>
        <span className="odos-office-text">{message.text}</span>
        <span className="odos-office-age">{ageLabel(message.sentAt)}{messages.length > 1 ? ` · 1 of ${messages.length}` : ""}</span>
        <button type="button" disabled={acknowledging === message.id} onClick={() => onAcknowledge(message.id)}>{acknowledging === message.id ? "Saving…" : "Got it ✓"}</button>
      </div>
    </div>
  );
}

export function PinnedOfficeNote({ patientId, compact = false }: { patientId?: string; compact?: boolean }) {
  const office = useOfficeChannel();
  const message = office.messages.find((candidate) => candidate.tier === "patient-pinned" && candidate.patient?.id === patientId);
  if (!message) return null;
  return (
    <details className={`odos-office-pin-context${message.acknowledgement ? " is-seen" : ""}${compact ? " is-compact" : ""}`}>
      <summary aria-label={`Pinned Office note from ${message.sender.display}`}>📌{message.acknowledgement ? " ✓" : ""}</summary>
      <div><strong>{message.sender.display}</strong><p>{message.text}</p><time>{ageLabel(message.sentAt)}</time>
        {message.acknowledgement
          ? <small>Seen ✓ by {message.acknowledgement.display} · {dateTimeLabel(message.acknowledgement.at)}</small>
          : <button type="button" disabled={office.acknowledging === message.id} onClick={() => office.acknowledge(message.id)}>{office.acknowledging === message.id ? "Saving…" : "Got it ✓"}</button>}
      </div>
    </details>
  );
}

function OfficeMessageCard({ message, acknowledging, onAcknowledge }: { message: OfficeMessage; acknowledging: boolean; onAcknowledge(id: string): Promise<void> }) {
  return <article className={`odos-office-message is-${message.tier}`}>
    <div><strong>{message.sender.display}</strong><time>{ageLabel(message.sentAt)}</time></div>
    <p>{message.text}</p>
    {message.patient && <span className="odos-office-pin">📌 {message.patient.display}</span>}
    {message.acknowledgement
      ? <small>Seen ✓ by {message.acknowledgement.display} · {dateTimeLabel(message.acknowledgement.at)}</small>
      : <button type="button" disabled={acknowledging} onClick={() => onAcknowledge(message.id)}>{acknowledging ? "Saving…" : "Got it ✓"}</button>}
  </article>;
}

export function ageLabel(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function navigateWithinApp(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState({}, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateTo(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
