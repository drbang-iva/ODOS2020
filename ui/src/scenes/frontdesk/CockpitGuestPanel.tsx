import clsx from "clsx";
import type { Patient } from "@medplum/fhirtypes";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { SmsOptOutControl } from "../../components/patient/SmsOptOutControl";
import { dockItem, type CockpitPanelId } from "../../lib/cockpit-shell";
import { sendSms } from "../../lib/communications-client";
import { patientName } from "../../lib/scheduler-appointment-ui";
import { PatientSearch } from "../PatientPicker";

export const COCKPIT_PANEL_POSITION_STORAGE_KEY = "odos-cockpit-panel-position";

export interface CockpitPanelPosition {
  floating: true;
  x: number;
  y: number;
}

type CockpitPositionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): CockpitPositionStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadCockpitPanelPosition(storage: Pick<CockpitPositionStorage, "getItem"> | undefined = browserStorage()): CockpitPanelPosition | null {
  try {
    const value = JSON.parse(storage?.getItem(COCKPIT_PANEL_POSITION_STORAGE_KEY) ?? "null") as Partial<CockpitPanelPosition> | null;
    return value?.floating === true && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { floating: true, x: value.x!, y: value.y! }
      : null;
  } catch {
    return null;
  }
}

export function saveCockpitPanelPosition(position: CockpitPanelPosition, storage: Pick<CockpitPositionStorage, "setItem"> | undefined = browserStorage()): void {
  try {
    storage?.setItem(COCKPIT_PANEL_POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    return;
  }
}

export function clearCockpitPanelPosition(storage: Pick<CockpitPositionStorage, "removeItem"> | undefined = browserStorage()): void {
  try {
    storage?.removeItem(COCKPIT_PANEL_POSITION_STORAGE_KEY);
  } catch {
    return;
  }
}

// Phone-width slide-over (design doc §2). The body stays a stub until each
// communications organ lands in Phases 3b–5b.
const PANEL_STUB: Record<CockpitPanelId, string> = {
  launcher: "Quick actions — New Message · New Call · Pay Request · New Fax (Phase 3b).",
  messages: "Two-way messaging with inline TEXT BACK · BOOK · PAY REQ (Phase 3b, GHL adapter).",
  calls: "Call history, one-click callback, voicemail + recording playback (Phase 3b).",
  requests: "Screened appointment requests, badge-counted for immediate review (Phase 4b).",
  "team-chat": "Internal staff channels, DMs, mentions, threads (Phase 5b).",
  notifications: "Cross-cutting payment + schedule event stream (later).",
  fax: "Fax inbox with sent/failed status + New Fax (later; fax provider TBD).",
};

export function CockpitGuestPanel({
  panel,
  open = true,
  onClose,
  onHoverEnter,
  onHoverLeave,
  position = null,
  onPositionChange,
  onPositionCommit,
  onRedock,
  selectedPatient,
}: {
  panel: CockpitPanelId;
  open?: boolean;
  onClose: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  position?: CockpitPanelPosition | null;
  onPositionChange?: (position: CockpitPanelPosition) => void;
  onPositionCommit?: (position: CockpitPanelPosition) => void;
  onRedock?: () => void;
  selectedPatient?: Patient;
}) {
  const item = dockItem(panel);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    panelLeft: number;
    panelTop: number;
    panelWidth: number;
    headerHeight: number;
    position: CockpitPanelPosition;
    latestPosition: CockpitPanelPosition;
    moved: boolean;
  }>();

  useEffect(() => {
    if (!open || !position || !panelRef.current) return;
    const clampPosition = () => {
      if (!panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      const headerHeight = panelRef.current.querySelector("header")?.getBoundingClientRect().height ?? 0;
      const clamped = clampPanelOffset(position, panelRect, headerHeight, window.innerWidth, window.innerHeight);
      if (clamped.x === position.x && clamped.y === position.y) return;
      onPositionChange?.(clamped);
      onPositionCommit?.(clamped);
    };
    clampPosition();
    window.addEventListener("resize", clampPosition);
    return () => window.removeEventListener("resize", clampPosition);
  }, [onPositionChange, onPositionCommit, open, position]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!open || event.button !== 0 || !panelRef.current) return;
    const panelRect = panelRef.current.getBoundingClientRect();
    const headerRect = event.currentTarget.getBoundingClientRect();
    const initialPosition = position ?? { floating: true, x: 0, y: 0 };
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      panelLeft: panelRect.left,
      panelTop: panelRect.top,
      panelWidth: panelRect.width,
      headerHeight: headerRect.height,
      position: initialPosition,
      latestPosition: initialPosition,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.pointerX;
    const deltaY = event.clientY - drag.pointerY;
    if (deltaX === 0 && deltaY === 0) return;
    event.preventDefault();
    const left = Math.min(Math.max(0, drag.panelLeft + deltaX), Math.max(0, window.innerWidth - drag.panelWidth));
    const top = Math.min(Math.max(0, drag.panelTop + deltaY), Math.max(0, window.innerHeight - drag.headerHeight));
    const nextPosition: CockpitPanelPosition = {
      floating: true,
      x: drag.position.x + left - drag.panelLeft,
      y: drag.position.y + top - drag.panelTop,
    };
    drag.latestPosition = nextPosition;
    drag.moved = true;
    onPositionChange?.(nextPosition);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) onPositionCommit?.(drag.latestPosition);
    dragRef.current = undefined;
  };

  return (
    <aside
      ref={panelRef}
      role={open ? "dialog" : undefined}
      aria-label={item.label}
      aria-hidden={!open}
      onPointerEnter={(event) => event.pointerType !== "touch" && onHoverEnter?.()}
      onPointerLeave={(event) => event.pointerType !== "touch" && onHoverLeave?.()}
      className={clsx(
        "odos-cockpit-panel fixed z-40 flex flex-col overflow-hidden border border-white/15 bg-[#0c0c18] shadow-2xl",
        open && "is-open",
        position && "is-floating",
      )}
      style={position ? ({
        "--odos-cockpit-panel-x": `${position.x}px`,
        "--odos-cockpit-panel-y": `${position.y}px`,
      } as CSSProperties) : undefined}
    >
      <header
        data-testid="cockpit-panel-drag-handle"
        title="Drag panel"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex shrink-0 touch-none select-none items-center justify-between border-b border-white/10 px-4 py-3 cursor-grab"
      >
        <span className="text-sm font-bold text-white">{item.label}</span>
        <span className="flex items-center gap-3">
          {position && (
            <button
              type="button"
              aria-label="Dock panel to rail"
              title="Dock panel to rail"
              disabled={!open}
              tabIndex={open ? 0 : -1}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onRedock}
              className="text-white/60 hover:text-white"
            >
              ⇥
            </button>
          )}
          <button
            type="button"
            aria-label="Close panel"
            disabled={!open}
            tabIndex={open ? 0 : -1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
            className="text-white/60 hover:text-white"
          >
            ✕
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 select-text overflow-y-auto p-4 text-sm leading-relaxed text-white/55">
        {panel === "messages"
          ? <MessagesPanel key={selectedPatient?.id ?? "patient-search"} selectedPatient={selectedPatient} />
          : PANEL_STUB[panel]}
      </div>
    </aside>
  );
}

function MessagesPanel({ selectedPatient: initialPatient }: { selectedPatient?: Patient }) {
  const [selectedPatient, setSelectedPatient] = useState(initialPatient);
  const [suppressed, setSuppressed] = useState(false);
  const [suppressionKnown, setSuppressionKnown] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string>();
  const idempotencyKey = useRef(newSmsIdempotencyKey());
  const conversationEpoch = useRef(0);
  const updateSuppression = useCallback((value: boolean) => {
    setSuppressed(value);
    setSuppressionKnown(true);
  }, []);
  const selectPatient = useCallback((patient: Patient | undefined) => {
    conversationEpoch.current += 1;
    setSelectedPatient(patient);
    setSuppressed(false);
    setSuppressionKnown(false);
    setMessage("");
    setSending(false);
    setSendStatus(undefined);
    idempotencyKey.current = newSmsIdempotencyKey();
  }, []);

  if (!selectedPatient?.id) {
    return (
      <section className="grid gap-3">
        <p>Select a patient conversation.</p>
        <PatientSearch actionLabel="Open thread" onSelect={selectPatient} />
      </section>
    );
  }

  const submit = async () => {
    if (!message.trim() || suppressed || !suppressionKnown || sending) return;
    const epoch = conversationEpoch.current;
    setSending(true);
    setSendStatus(undefined);
    try {
      const result = await sendSms({
        patientReference: `Patient/${selectedPatient.id}`,
        body: message.trim(),
        idempotencyKey: idempotencyKey.current,
      });
      if (epoch !== conversationEpoch.current) return;
      if (result.outcome === "suppressed") {
        setSuppressed(true);
        setSendStatus("Texting is blocked by the patient SMS opt-out.");
        return;
      }
      setMessage("");
      idempotencyKey.current = newSmsIdempotencyKey();
      setSendStatus(result.outcome === "sent" ? "Text sent." : "Text scheduled for the next allowed window.");
    } catch (cause) {
      if (epoch !== conversationEpoch.current) return;
      setSendStatus(cause instanceof Error ? cause.message : "Text could not be sent.");
    } finally {
      if (epoch === conversationEpoch.current) setSending(false);
    }
  };

  return (
    <section className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-[color:var(--odos-text)]">{patientName(selectedPatient)}</strong>
        <button type="button" onClick={() => selectPatient(undefined)} className="text-xs text-blue-200 underline">
          Change patient
        </button>
      </div>
      <SmsOptOutControl
        patientReference={`Patient/${selectedPatient.id}`}
        activeLaneRole="transactional-sms"
        onActiveLaneSuppressionChange={updateSuppression}
      />
      <label className="grid gap-2 text-xs font-semibold text-[color:var(--odos-muted)]">
        Message
        <textarea
          aria-label="Compose text message"
          value={message}
          disabled={!suppressionKnown || suppressed || sending}
          onChange={(event) => setMessage(event.target.value)}
          className="scheduler-input min-h-28 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>
      <button type="button" disabled={!suppressionKnown || suppressed || sending || !message.trim()} onClick={() => void submit()} className="rounded bg-brand px-3 py-2 font-semibold text-[color:var(--odos-accent-ink)] disabled:opacity-50">
        {sending ? "Sending…" : "Send text"}
      </button>
      {sendStatus && <p role="status" className="text-xs text-[color:var(--odos-muted)]">{sendStatus}</p>}
    </section>
  );
}

function newSmsIdempotencyKey(): string {
  return `odos-ui-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function clampPanelOffset(position: CockpitPanelPosition, panelRect: DOMRect, headerHeight: number, viewportWidth: number, viewportHeight: number): CockpitPanelPosition {
  const left = Math.min(Math.max(0, panelRect.left), Math.max(0, viewportWidth - panelRect.width));
  const top = Math.min(Math.max(0, panelRect.top), Math.max(0, viewportHeight - headerHeight));
  return {
    floating: true,
    x: position.x + left - panelRect.left,
    y: position.y + top - panelRect.top,
  };
}
