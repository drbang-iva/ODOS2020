import { useCallback, useEffect, useState } from "react";
import { acknowledgeOfficeMessage, fetchOfficeMessages, type OfficeMessage } from "../lib/office-channel";

export interface OfficeInboxApi {
  list: typeof fetchOfficeMessages;
  acknowledge: typeof acknowledgeOfficeMessage;
}

const defaultApi: OfficeInboxApi = { list: fetchOfficeMessages, acknowledge: acknowledgeOfficeMessage };

export function useOfficeInbox(options: { initialMessages?: OfficeMessage[]; pollMs?: number; api?: OfficeInboxApi } = {}) {
  const api = options.api ?? defaultApi;
  const [messages, setMessages] = useState(options.initialMessages ?? []);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    try { setMessages(await api.list("inbox", "all")); setError(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Office channel unavailable."); }
  }, [api]);

  useEffect(() => {
    if (options.initialMessages || typeof window === "undefined") return;
    void refresh();
    const handle = window.setInterval(() => void refresh(), options.pollMs ?? 15_000);
    return () => window.clearInterval(handle);
  }, [options.initialMessages, options.pollMs, refresh]);

  async function acknowledge(messageId: string) {
    try {
      const updated = await api.acknowledge(messageId);
      setMessages((current) => current.map((message) => message.id === messageId ? updated : message));
      setError(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Office acknowledgement failed."); }
  }

  const unread = messages.filter((message) => message.acknowledgements.length === 0);
  return { messages, unread, open, setOpen, error, acknowledge, refresh };
}

export function OfficePill({ count, open, onClick }: { count: number; open: boolean; onClick(): void }) {
  return <button className="odos-pill odos-office-pill" type="button" aria-expanded={open} onClick={onClick}>Office {count > 0 && <span className="odos-office-badge">{count}</span>}</button>;
}

export function OfficeInboxPanel({ messages, error, onAcknowledge, onClose }: { messages: OfficeMessage[]; error?: string; onAcknowledge(id: string): Promise<void>; onClose(): void }) {
  return (
    <aside className="odos-office-panel" aria-label="Office messages">
      <div className="odos-office-panel-head"><div><strong>Office</strong><span>Internal staff channel</span></div><button type="button" onClick={onClose}>×</button></div>
      {error && <p role="alert" className="odos-office-error">{error}</p>}
      {messages.length === 0 && !error && <p className="odos-office-empty">No office messages.</p>}
      {messages.map((message) => <OfficeMessageCard key={message.id} message={message} onAcknowledge={onAcknowledge} />)}
    </aside>
  );
}

export function UrgentOfficeBanner({ message, onAcknowledge }: { message?: OfficeMessage; onAcknowledge(id: string): Promise<void> }) {
  if (!message) return null;
  return (
    <div className="odos-office-nudge" role="status">
      <div className="odos-office-nudge-inner">
        <span className="odos-office-from">{message.sender.display}</span><span className="odos-office-text">{message.text}</span><span className="odos-office-age">{ageLabel(message.sentAt)}</span>
        <button type="button" onClick={() => onAcknowledge(message.id)}>Got it ✓</button>
      </div>
    </div>
  );
}

export function PinnedOfficeNote({ messages, patientId }: { messages: OfficeMessage[]; patientId?: string }) {
  const message = messages.find((candidate) => candidate.patient?.id === patientId && candidate.acknowledgements.length === 0);
  return message ? <span className="odos-office-pin">📌 {message.sender.display}: {message.text}</span> : null;
}

function OfficeMessageCard({ message, onAcknowledge }: { message: OfficeMessage; onAcknowledge(id: string): Promise<void> }) {
  const seen = message.acknowledgements[0];
  return <article className={`odos-office-message${message.urgent ? " is-urgent" : ""}`}>
    <div><strong>{message.sender.display}</strong><time>{ageLabel(message.sentAt)}</time></div>
    <p>{message.text}</p>
    {message.patient && <span className="odos-office-pin">📌 {message.patient.display}</span>}
    {seen ? <small>Seen ✓ by {seen.display} · {dateTimeLabel(seen.at)}</small> : <button type="button" onClick={() => onAcknowledge(message.id)}>Got it ✓</button>}
  </article>;
}

export function ageLabel(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function dateTimeLabel(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
