import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { acknowledgeOfficeMessage, fetchClinicOfficeMessages, type OfficeMessage } from "../lib/office-channel";
import { CLINIC_PATH } from "../scenes/DeskHome";

const CLINIC_PATIENTS_PATH = "/clinic/patients";

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

export function useOfficeChannel(): OfficeChannelState {
  return useContext(OfficeChannelContext) ?? emptyState;
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
  location,
  switchPill,
  children,
  initialMessages,
  officeApi,
  pollMs = 15_000,
}: {
  location: string;
  switchPill?: ReactNode;
  children: ReactNode;
  initialMessages?: OfficeMessage[];
  officeApi?: OfficeInboxApi;
  pollMs?: number;
}) {
  const office = useOfficeInbox({ initialMessages, pollMs, api: officeApi });
  return (
    <OfficeChannelContext.Provider value={office}>
      <div className="odos-clinic-shell">
        <header className="odos-desk-topbar">
          <a className="odos-mark" href={CLINIC_PATH} onClick={navigateWithinApp}>ODOS <b>20/20</b></a>
          <span className="odos-location">{location}</span>
          <span className="odos-topbar-spacer" />
          <OfficePill count={office.unread.length} open={office.open} onClick={() => office.setOpen(!office.open)} />
          <a className="odos-pill" href={CLINIC_PATIENTS_PATH} onClick={navigateWithinApp}>Sections</a>
          {switchPill}
        </header>
        <UrgentOfficeBanner messages={office.unread.filter((message) => message.tier === "urgent")} onAcknowledge={office.acknowledge} acknowledging={office.acknowledging} />
        {office.open && <OfficeInboxPanel messages={office.messages} error={office.error} acknowledging={office.acknowledging} onAcknowledge={office.acknowledge} onClose={() => office.setOpen(false)} />}
        {children}
      </div>
    </OfficeChannelContext.Provider>
  );
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
