import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import type { Patient } from "@medplum/fhirtypes";
import { CockpitBadgeDock } from "./frontdesk/CockpitBadgeDock";
import { clearCockpitPanelPosition, CockpitGuestPanel, loadCockpitPanelPosition, saveCockpitPanelPosition, type CockpitPanelPosition } from "./frontdesk/CockpitGuestPanel";
import type { CockpitPanelId } from "../lib/cockpit-shell";
import { fetchDeskSummary, type DeskStat, type DeskSummary, type DeskTone } from "../lib/desk-summary";
import { fetchDeskOfficeMessages, sendOfficeMessage, type OfficeMessage, type OfficeTier } from "../lib/office-channel";
import { PatientSearch } from "./PatientPicker";
import { useOfficeChannel } from "../components/OfficeChannel";

export const DESK_LABEL = "Desk";
export { CLINIC_PATH, DESK_HOME_PATH } from "../lib/app-paths";
export const DESK_CARD_STORAGE_KEY = "odos.desk.cards.v2";
export const COCKPIT_HOVER_CLOSE_DELAY_MS = 250;

export interface DeskOfficeApi {
  list: typeof fetchDeskOfficeMessages;
  send: typeof sendOfficeMessage;
}

const defaultDeskOfficeApi: DeskOfficeApi = { list: fetchDeskOfficeMessages, send: sendOfficeMessage };

export const DESK_CARDS = [
  { id: "schedule", title: "Today's schedule", href: "/frontdesk", span: "wide" },
  { id: "attention", title: "Needs attention", href: "/billing/claims/worklist", span: "standard" },
  { id: "front-line", title: "Front Line", span: "standard" },
  { id: "office", title: "Office", span: "full" },
  { id: "rx", title: "Pending Rx", href: "/clinic/patients", span: "standard" },
  { id: "pickup", title: "Product pickup", href: "/dispensary/lab-orders", span: "standard" },
  { id: "claims", title: "Claims", href: "/billing/claims/worklist", span: "standard" },
  { id: "payments", title: "Payments", href: "/billing/claims/patient-payments", span: "standard" },
  { id: "remits", title: "Electronic remits", href: "/billing/claims/remittances", span: "half" },
  { id: "statements", title: "Statements", href: "/billing/statements", span: "half" },
] as const;

export type DeskCardId = (typeof DESK_CARDS)[number]["id"];
const DEFAULT_CARD_IDS = DESK_CARDS.map((card) => card.id);

export function sanitizeDeskCardIds(value: unknown): DeskCardId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CARD_IDS];
  const available = new Set<DeskCardId>(DEFAULT_CARD_IDS);
  const seen = new Set<DeskCardId>();
  return value.filter((id): id is DeskCardId => {
    if (typeof id !== "string" || !available.has(id as DeskCardId) || seen.has(id as DeskCardId)) return false;
    seen.add(id as DeskCardId);
    return true;
  });
}

export function reorderDeskCards(ids: readonly DeskCardId[], source: DeskCardId, target: DeskCardId): DeskCardId[] {
  const next = [...ids];
  const from = next.indexOf(source);
  const to = next.indexOf(target);
  if (from < 0 || to < 0 || from === to) return next;
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export function loadDeskCardIds(storage: Pick<Storage, "getItem"> | undefined): DeskCardId[] {
  const stored = storage?.getItem(DESK_CARD_STORAGE_KEY);
  if (!stored) return [...DEFAULT_CARD_IDS];
  try { return sanitizeDeskCardIds(JSON.parse(stored)); } catch { return [...DEFAULT_CARD_IDS]; }
}

function navigateWithinApp(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState({}, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function DeskHome({ initialSummary, initialOfficeMessages, officeApi = defaultDeskOfficeApi }: { initialSummary?: DeskSummary; initialOfficeMessages?: OfficeMessage[]; officeApi?: DeskOfficeApi } = {}) {
  const sharedOffice = useOfficeChannel();
  const [customizing, setCustomizing] = useState(false);
  const [cardIds, setCardIds] = useState<DeskCardId[]>(() => loadDeskCardIds(typeof window === "undefined" ? undefined : window.localStorage));
  const [dragged, setDragged] = useState<DeskCardId | null>(null);
  const [panelPosition, setPanelPosition] = useState<CockpitPanelPosition | null>(() => loadCockpitPanelPosition());
  const [hoveredPanel, setHoveredPanel] = useState<CockpitPanelId | null>(null);
  const [pinnedPanel, setPinnedPanel] = useState<CockpitPanelId | null>(() => panelPosition ? "messages" : null);
  const [renderedPanel, setRenderedPanel] = useState<CockpitPanelId>("messages");
  const [summary, setSummary] = useState<DeskSummary | undefined>(initialSummary);
  const [summaryError, setSummaryError] = useState<string>();
  const [localSentMessages, setLocalSentMessages] = useState(initialOfficeMessages ?? []);
  const [localOfficeError, setLocalOfficeError] = useState<string>();
  const [messageText, setMessageText] = useState("");
  const [tier, setTier] = useState<OfficeTier>("ambient");
  const [pinnedPatient, setPinnedPatient] = useState<Patient>();
  const [sending, setSending] = useState(false);
  const officeRequestIdRef = useRef(0);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const openPanel = pinnedPanel ?? hoveredPanel;
  const sentMessages = sharedOffice.provided ? sharedOffice.messages : localSentMessages;
  const officeError = sharedOffice.provided ? sharedOffice.error : localOfficeError;

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current === undefined) return;
    clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = undefined;
  }, []);

  const closePanel = useCallback(() => {
    cancelHoverClose();
    setHoveredPanel(null);
    setPinnedPanel(null);
  }, [cancelHoverClose]);

  const hoverPanel = useCallback((panel: CockpitPanelId) => {
    if (pinnedPanel) return;
    cancelHoverClose();
    setRenderedPanel(panel);
    if (panelPosition) {
      setHoveredPanel(null);
      setPinnedPanel(panel);
    } else {
      setHoveredPanel(panel);
    }
  }, [cancelHoverClose, panelPosition, pinnedPanel]);

  const scheduleHoverClose = useCallback(() => {
    if (panelPosition) return;
    cancelHoverClose();
    hoverCloseTimerRef.current = setTimeout(() => {
      hoverCloseTimerRef.current = undefined;
      setHoveredPanel(null);
    }, COCKPIT_HOVER_CLOSE_DELAY_MS);
  }, [cancelHoverClose, panelPosition]);

  const togglePinnedPanel = useCallback((panel: CockpitPanelId) => {
    cancelHoverClose();
    setRenderedPanel(panel);
    setHoveredPanel(null);
    setPinnedPanel((current) => panelPosition ? panel : current === panel ? null : panel);
  }, [cancelHoverClose, panelPosition]);

  const openPinnedPanel = useCallback((panel: CockpitPanelId) => {
    cancelHoverClose();
    setRenderedPanel(panel);
    setHoveredPanel(null);
    setPinnedPanel(panel);
  }, [cancelHoverClose]);

  const floatPanel = useCallback((position: CockpitPanelPosition) => {
    cancelHoverClose();
    setPanelPosition(position);
    setHoveredPanel(null);
    setPinnedPanel(renderedPanel);
  }, [cancelHoverClose, renderedPanel]);

  const commitPanelPosition = useCallback((position: CockpitPanelPosition) => {
    saveCockpitPanelPosition(position);
  }, []);

  const redockPanel = useCallback(() => {
    cancelHoverClose();
    clearCockpitPanelPosition();
    setPanelPosition(null);
    setPinnedPanel(null);
    setHoveredPanel(renderedPanel);
  }, [cancelHoverClose, renderedPanel]);

  const refreshSent = useCallback(async () => {
    const requestId = ++officeRequestIdRef.current;
    try {
      const next = await officeApi.list();
      if (requestId !== officeRequestIdRef.current) return;
      setLocalSentMessages(next);
      setLocalOfficeError(undefined);
    } catch (reason) {
      if (requestId === officeRequestIdRef.current) setLocalOfficeError(reason instanceof Error ? reason.message : "Office channel unavailable.");
    }
  }, [officeApi]);

  useEffect(() => { window.localStorage.setItem(DESK_CARD_STORAGE_KEY, JSON.stringify(cardIds)); }, [cardIds]);
  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);
  useEffect(() => {
    if (!openPanel || typeof document === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => event.key === "Escape" && closePanel();
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel, openPanel]);
  useEffect(() => {
    if (initialSummary) return;
    let active = true;
    fetchDeskSummary().then((value) => active && setSummary(value)).catch((error) => active && setSummaryError(error instanceof Error ? error.message : "Desk summary unavailable."));
    return () => { active = false; };
  }, [initialSummary]);
  useEffect(() => {
    if (initialOfficeMessages || sharedOffice.provided) return;
    void refreshSent();
    const handle = window.setInterval(() => void refreshSent(), 10_000);
    return () => {
      window.clearInterval(handle);
      officeRequestIdRef.current += 1;
    };
  }, [initialOfficeMessages, refreshSent, sharedOffice.provided]);
  const hiddenCards = DESK_CARDS.filter((card) => !cardIds.includes(card.id));
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  async function submitOfficeMessage(event: FormEvent) {
    event.preventDefault();
    if (!messageText.trim()) return;
    setSending(true);
    officeRequestIdRef.current += 1;
    try {
      const created = await officeApi.send({
        text: messageText,
        tier,
        ...(tier === "patient-pinned" && pinnedPatient?.id ? { patientId: pinnedPatient.id } : {}),
      });
      if (sharedOffice.provided) await sharedOffice.refresh();
      else setLocalSentMessages((current) => [created, ...current]);
      setMessageText("");
      setTier("ambient");
      setPinnedPatient(undefined);
      setLocalOfficeError(undefined);
    } catch (reason) { setLocalOfficeError(reason instanceof Error ? reason.message : "Office message could not be sent."); }
    finally { setSending(false); }
  }

  return (
    <main className="odos-desk">
      <div className="odos-ambient" aria-hidden="true" />
      <section className="odos-desk-body">
        <div className="odos-desk-greeting"><h1>Good day.</h1><span>{date}</span><span className="odos-mode">The {DESK_LABEL}</span><button className="odos-pill" type="button" onClick={() => setCustomizing((value) => !value)} aria-pressed={customizing}>Customize</button></div>
        <PracticePulse summary={summary} error={summaryError} />
        {summary && <a className={`odos-day-chip odos-live-tone-${summary.day.collectedCents.tone}`} href="/desk/ledger" onClick={navigateWithinApp}>{summary.day.collectedCents.value === null ? "Day total unavailable" : `Day open · ${money(summary.day.collectedCents.value)} collected`} <span>→</span></a>}
        {customizing && (
          <section className="odos-customizer" aria-label="Customize home cards">
            <div><strong>Arrange your home</strong><p>Drag visible cards to reorder them. This layout is saved on this workstation.</p></div>
            {hiddenCards.length > 0 && <div className="odos-card-catalog">{hiddenCards.map((card) => <button key={card.id} type="button" onClick={() => setCardIds((ids) => [...ids, card.id])}>+ {card.title}</button>)}</div>}
            <button type="button" onClick={() => setCardIds([...DEFAULT_CARD_IDS])}>Reset</button>
          </section>
        )}

        <div className="odos-card-grid">
          {cardIds.map((id) => {
            const card = DESK_CARDS.find((candidate) => candidate.id === id)!;
            const model = id === "office"
              ? { tone: sentMessages.some((message) => !message.acknowledgement) ? "warn" as const : "ok" as const, kicker: sentMessages.some((message) => !message.acknowledgement) ? "awaiting acknowledgement" : "closed loop", target: "every message acknowledged", content: <OfficeDeskCard /> }
              : cardModel(id, summary);
            return (
              <article id={card.id} key={card.id} className={`odos-desk-card odos-live-tone-${model.tone} odos-span-${card.span}`} draggable={customizing}
                onDragStart={() => setDragged(card.id)} onDragOver={(event) => customizing && event.preventDefault()}
                onDrop={() => { if (dragged) setCardIds((ids) => reorderDeskCards(ids, dragged, card.id)); setDragged(null); }}>
                <div className="odos-card-content">
                  <span className="odos-card-edge" /><span className="odos-card-kicker">{card.title} <i>· {model.kicker}</i></span>
                  {model.content}
                  <span className="odos-card-target">Target: {model.target}</span>
                  {id === "office" ? null
                    : id === "front-line" ? <button className="odos-card-link" type="button" onClick={() => openPinnedPanel("messages")}>Open desk inbox →</button>
                    : "href" in card ? <a className="odos-card-link" href={card.href} onClick={navigateWithinApp}>Open section →</a>
                      : <span className="odos-card-link odos-card-link-off">Not yet available</span>}
                </div>
                {customizing && <button className="odos-card-remove" type="button" aria-label={`Remove ${card.title}`} onClick={() => setCardIds((ids) => ids.filter((item) => item !== card.id))}>×</button>}
              </article>
            );
          })}
        </div>
      </section>

      <div className="odos-dock">
        <CockpitBadgeDock
          openPanel={openPanel}
          pinnedPanel={pinnedPanel}
          onToggle={togglePinnedPanel}
          onHover={hoverPanel}
          onHoverLeave={scheduleHoverClose}
        />
      </div>
      <CockpitGuestPanel
        panel={renderedPanel}
        open={openPanel !== null}
        onClose={closePanel}
        onHoverEnter={cancelHoverClose}
        onHoverLeave={scheduleHoverClose}
        position={panelPosition}
        onPositionChange={floatPanel}
        onPositionCommit={commitPanelPosition}
        onRedock={redockPanel}
      />
    </main>
  );

  function OfficeDeskCard() {
    const patientMissing = tier === "patient-pinned" && !pinnedPatient?.id;
    return <div className="odos-office-card">
      <form onSubmit={submitOfficeMessage}>
        <div className="odos-office-tier" role="group" aria-label="Office message tier">
          <button type="button" className={tier === "ambient" ? "is-active" : ""} onClick={() => { setTier("ambient"); setPinnedPatient(undefined); }}>Note</button>
          <button type="button" className={tier === "urgent" ? "is-active" : ""} onClick={() => { setTier("urgent"); setPinnedPatient(undefined); }}>Urgent</button>
          <button type="button" className={tier === "patient-pinned" ? "is-active" : ""} onClick={() => setTier("patient-pinned")}>📌 Patient</button>
        </div>
        <label>Message<textarea aria-label="Office message" value={messageText} maxLength={1000} onChange={(event) => setMessageText(event.target.value)} /></label>
        {tier === "patient-pinned" && <details open={!pinnedPatient}>
          <summary>{pinnedPatient ? `📌 ${displayPatientName(pinnedPatient)}` : "Choose the patient for this pin"}</summary>
          <PatientSearch actionLabel="Pin" onSelect={setPinnedPatient} />
        </details>}
        <button type="submit" disabled={sending || !messageText.trim() || patientMissing}>{sending ? "Sending…" : tier === "urgent" ? "Send urgent" : tier === "patient-pinned" ? "Pin to patient" : "Send note"}</button>
      </form>
      <section className="odos-office-sent" aria-label="Sent Office messages"><h2>Sent</h2>
        {officeError && <p className="odos-office-error" role="alert">{officeError}</p>}
        {sentMessages.length === 0 && !officeError && <p className="odos-office-empty">No sent Office messages.</p>}
        {sentMessages.map((message) => <article key={message.id} className={`is-${message.tier}`}>
          <div><strong>{tierLabel(message)}</strong><time>{officeDateTime(message.sentAt)}</time></div><p>{message.text}</p>
          {message.patient && <span className="odos-office-pin">📌 {message.patient.display}</span>}
          <small>{message.acknowledgement ? `Seen ✓ by ${message.acknowledgement.display} · ${officeDateTime(message.acknowledgement.at)}` : "Sent · awaiting acknowledgement"}</small>
        </article>)}
      </section>
    </div>;
  }
}

function displayPatientName(patient: Patient): string {
  const name = patient.name?.find((candidate) => candidate.use === "usual") ?? patient.name?.[0];
  return [name?.given?.join(" "), name?.family].filter(Boolean).join(" ") || `Patient/${patient.id}`;
}

function officeDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }

function tierLabel(message: OfficeMessage): string {
  if (message.tier === "urgent") return "Urgent · Clinic side";
  if (message.tier === "patient-pinned") return `Pinned · ${message.patient?.display ?? "patient"}`;
  return "Note · Clinic side";
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function PracticePulse({ summary, error }: { summary?: DeskSummary; error?: string }) {
  if (error) return <p className="odos-practice-pulse odos-pulse-off">Live practice pulse unavailable — {error}</p>;
  if (!summary) return <p className="odos-practice-pulse odos-pulse-off">Loading live practice pulse…</p>;
  const count = summary.pulse.itemsNeedingYou;
  const last = summary.pulse.lastClaimTransmission ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(summary.pulse.lastClaimTransmission)) : "not available";
  return <p className="odos-practice-pulse"><b>{count} item{count === 1 ? "" : "s"} need you</b> · everything else at target · last claim transmission {last}{summary.pulse.lastClaimTransmissionTone === "ok" ? " ✓" : ""}</p>;
}

function cardModel(id: DeskCardId, summary?: DeskSummary): { tone: DeskTone; kicker: string; target: string; content: ReactNode } {
  if (!summary) return { tone: "off", kicker: "loading", target: "live practice data", content: <WiringPanel>Loading live counts…</WiringPanel> };
  switch (id) {
    case "office": throw new Error("Office card is rendered from live Office channel state.");
    case "schedule": { const value = summary.cards.schedule; return { tone: worstTone([value.today, value.confirmed, value.checkedIn, value.webRequests]), kicker: value.webRequests.value ? `${value.webRequests.value} web requests waiting` : "on track", target: "web requests 0 · confirmations match schedule", content: <><Stats stats={[["Today", value.today], ["Confirmed", value.confirmed], ["Checked in", value.checkedIn], ["Web requests", value.webRequests]]} /><div className="odos-agenda">{value.agenda.map((row, index) => <div key={`${row.time}-${index}`}><time>{row.time}</time><span>{row.patient}</span><em>{row.visitType}</em></div>)}</div></> }; }
    case "attention": { const items = summary.cards.attention.items; return { tone: items[0]?.tone ?? "ok", kicker: items.length ? `${items.length} item${items.length === 1 ? "" : "s"} need you` : "clear", target: "clear by EOD", content: items.length ? <div className="odos-attention-list">{items.map((item) => <div key={item.label} className={`odos-row-tone-${item.tone}`}><TonePip tone={item.tone} /><span><b>{item.label}</b><small>{item.detail}</small></span></div>)}</div> : <p className="odos-all-clear">All clear — nothing needs you.</p> }; }
    case "front-line": return { tone: "off", kicker: "wiring", target: "need reply 0 · urgent handled now", content: <WiringPanel>{summary.cards.frontLine.message}</WiringPanel> };
    case "rx": { const value = summary.cards.pendingRx; return { tone: worstTone([value.spectacle, value.contactLens, value.labOrdersUnsent, value.oldestWaiting]), kicker: value.oldestWaiting.value !== null && value.oldestWaiting.value > 1 ? `${value.oldestWaiting.value}d oldest wait` : "orders moving", target: "oldest waiting ≤ 1 day", content: <Stats stats={[["Spectacle", value.spectacle], ["CL", value.contactLens], ["Lab unsent", value.labOrdersUnsent], ["Oldest", value.oldestWaiting, "d"]]} /> }; }
    case "pickup": { const value = summary.cards.productPickup; return { tone: worstTone([value.openOrders, value.atLab, value.readyNotNotified, value.awaitingPickup]), kicker: value.readyNotNotified.value === null ? "partial contract" : value.readyNotNotified.value ? `${value.readyNotNotified.value} not notified` : "on track", target: "ready-not-notified 0", content: <Stats stats={[["Open orders", value.openOrders], ["At lab", value.atLab], ["Ready, not notified", value.readyNotNotified], ["Awaiting pickup", value.awaitingPickup]]} /> }; }
    case "claims": { const value = summary.cards.claims; return { tone: worstTone([value.failed, value.inProcess, value.paperQueue, value.heldCents, value.lastTransmission]), kicker: value.failed.value ? `${value.failed.value} failed` : value.lastTransmission.tone === "warn" ? "transmission due" : "on track", target: "failed 0 · transmit each business day", content: <Stats stats={[["Failed", value.failed], ["In process", value.inProcess], ["Paper queue", value.paperQueue], ["Held", value.heldCents, "$"], ["Last transmission", value.lastTransmission]]} /> }; }
    case "payments": { const value = summary.cards.payments; return { tone: worstTone([value.unappliedCount, value.unappliedCents, value.patientCreditsOpen, value.patientOpenBalanceCents, value.terminalMode]), kicker: value.terminalMode.value === "TEST MODE" ? "test mode" : value.unappliedCount.value ? `${value.unappliedCount.value} unapplied` : "reconciled", target: "unapplied 0 · live terminal before launch", content: <Stats stats={[["Unapplied", value.unappliedCount], ["Unapplied $", value.unappliedCents, "$"], ["Credits open", value.patientCreditsOpen], ["Open balance", value.patientOpenBalanceCents, "$"], ["Terminal", value.terminalMode]]} /> }; }
    case "remits": { const value = summary.cards.remits; return { tone: worstTone([value.waitingToPost, value.unpostedCents]), kicker: value.waitingToPost.value ? `${value.waitingToPost.value} waiting` : "posted", target: "waiting-to-post 0", content: <Stats stats={[["Waiting to post", value.waitingToPost], ["Unposted", value.unpostedCents, "$"]]} /> }; }
    case "statements": { const value = summary.cards.statements; return { tone: worstTone([value.cadence, value.invalidRejects, value.lastStatement]), kicker: value.invalidRejects.value ? `${value.invalidRejects.value} invalid` : value.lastStatement.value ? "run recorded" : "ready", target: "weekly · Wednesday · invalid/rejects 0", content: <Stats stats={[["Cadence", value.cadence], ["Invalid / rejects", value.invalidRejects], ["Last run", value.lastStatement, "date-time"]]} /> }; }
  }
}

function Stats({ stats }: { stats: Array<[string, DeskStat, string?]> }) {
  return <div className="odos-live-stats">{stats.map(([label, statValue, format]) => <div key={label} className={`odos-stat-tone-${statValue.tone}`} title={statValue.unavailableReason}><span><TonePip tone={statValue.tone} />{label}</span><strong>{displayStat(statValue.value, format)}</strong>{statValue.value === null && <small>Not wired</small>}</div>)}</div>;
}

function TonePip({ tone }: { tone: DeskTone }) { return <i className={`odos-tone-pip odos-pip-${tone}`} aria-label={tone} />; }
function WiringPanel({ children }: { children: ReactNode }) { return <div className="odos-wiring-panel">{children}</div>; }
export function displayStat(value: unknown, format?: string): string {
  if (value === null || value === undefined) return "—";
  if (format === "$") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value) / 100);
  if (format === "date-time") {
    const date = new Date(String(value));
    return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
  return `${value}${format ?? ""}`;
}
function worstTone(stats: DeskStat[]): DeskTone {
  const order: DeskTone[] = ["alert", "warn", "info", "ok", "off"];
  return order.find((tone) => stats.some((item) => item.tone === tone)) ?? "off";
}
