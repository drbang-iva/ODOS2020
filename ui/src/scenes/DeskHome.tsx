import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { CockpitBadgeDock } from "./frontdesk/CockpitBadgeDock";
import { CockpitGuestPanel } from "./frontdesk/CockpitGuestPanel";
import type { CockpitPanelId } from "../lib/cockpit-shell";
import { fetchDeskSummary, type DeskStat, type DeskSummary, type DeskTone } from "../lib/desk-summary";

export const DESK_LABEL = "Desk";
export const DESK_HOME_PATH = "/desk";
export const CLINIC_PATH = "/clinic";
export const DESK_CARD_STORAGE_KEY = "osod.desk.cards.v1";

export const DESK_CARDS = [
  { id: "schedule", title: "Today's schedule", href: "/frontdesk", span: "wide" },
  { id: "attention", title: "Needs attention", href: "/billing/claims/worklist", span: "standard" },
  { id: "front-line", title: "Front Line", span: "standard" },
  { id: "rx", title: "Pending Rx", href: "/dispensary/orders", span: "standard" },
  { id: "pickup", title: "Product pickup", href: "/dispensary/orders", span: "standard" },
  { id: "claims", title: "Claims", href: "/billing/claims/worklist", span: "standard" },
  { id: "payments", title: "Payments", href: "/billing/claims/patient-payments", span: "standard" },
  { id: "remits", title: "Electronic remits", href: "/billing/claims/remittances", span: "half" },
  { id: "statements", title: "Statements", span: "half" },
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

const SECTIONS = [
  { label: "Every day", items: [
    ["Reports", "Sales, production, and aging", "/billing/claims/reports/accounts-receivable"],
    ["Claims workbench", "Transmission, remits, and denial worklists", "/billing/claims/worklist"],
    ["Patient recall", "Recall workflow", ""],
    ["Statements & letters", "Patient statements and batch letters", ""],
    ["OpenDesk", "Connected communications workspace", ""],
  ] },
  { label: "Setup & admin", items: [
    ["Administration", "Practice configuration", "/settings"],
    ["Catalog & pricing", "Frames catalog and pricing", "/admin/optical/catalog/frames"],
    ["Inventory", "Frames inventory and adjustments", "/admin/optical/inventory/frames"],
    ["Integrations", "Frames Data and connected services", "/admin/practice/settings/frames-data"],
    ["Audit log", "Every access and change", "/audit/log"],
  ] },
] as const;

export function DeskHome({ initialSummary }: { initialSummary?: DeskSummary } = {}) {
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [cardIds, setCardIds] = useState<DeskCardId[]>(() => loadDeskCardIds(typeof window === "undefined" ? undefined : window.localStorage));
  const [dragged, setDragged] = useState<DeskCardId | null>(null);
  const [openPanel, setOpenPanel] = useState<CockpitPanelId | null>(null);
  const [summary, setSummary] = useState<DeskSummary | undefined>(initialSummary);
  const [summaryError, setSummaryError] = useState<string>();

  useEffect(() => { window.localStorage.setItem(DESK_CARD_STORAGE_KEY, JSON.stringify(cardIds)); }, [cardIds]);
  useEffect(() => {
    if (initialSummary) return;
    let active = true;
    fetchDeskSummary().then((value) => active && setSummary(value)).catch((error) => active && setSummaryError(error instanceof Error ? error.message : "Desk summary unavailable."));
    return () => { active = false; };
  }, [initialSummary]);
  useEffect(() => {
    if (!sectionsOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSectionsOpen(false);
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [sectionsOpen]);

  const hiddenCards = DESK_CARDS.filter((card) => !cardIds.includes(card.id));
  const date = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  return (
    <main className="odos-desk">
      <div className="odos-ambient" aria-hidden="true" />
      <header className="odos-desk-topbar">
        <a className="odos-mark" href={DESK_HOME_PATH} onClick={navigateWithinApp}>ODOS <b>20/20</b></a>
        <span className="odos-location">Practice home</span><div className="odos-topbar-spacer" />
        <button className="odos-pill" type="button" onClick={() => setCustomizing((value) => !value)} aria-pressed={customizing}>Customize</button>
        <button className="odos-pill" type="button" onClick={() => setSectionsOpen(true)}>Sections</button>
        <a className="odos-pill odos-clinic-pill" href={CLINIC_PATH} target="_blank" rel="noopener noreferrer">Clinic <span aria-hidden>↗</span></a>
      </header>

      <section className="odos-desk-body">
        <div className="odos-desk-greeting"><h1>Good day.</h1><span>{date}</span><span className="odos-mode">The {DESK_LABEL}</span></div>
        <PracticePulse summary={summary} error={summaryError} />
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
            const model = cardModel(id, summary);
            return (
              <article key={card.id} className={`odos-desk-card odos-live-tone-${model.tone} odos-span-${card.span}`} draggable={customizing}
                onDragStart={() => setDragged(card.id)} onDragOver={(event) => customizing && event.preventDefault()}
                onDrop={() => { if (dragged) setCardIds((ids) => reorderDeskCards(ids, dragged, card.id)); setDragged(null); }}>
                <div className="odos-card-content">
                  <span className="odos-card-edge" /><span className="odos-card-kicker">{card.title} <i>· {model.kicker}</i></span>
                  {model.content}
                  <span className="odos-card-target">Target: {model.target}</span>
                  {id === "front-line" ? <button className="odos-card-link" type="button" onClick={() => setOpenPanel("messages")}>Open desk inbox →</button>
                    : "href" in card ? <a className="odos-card-link" href={card.href} onClick={navigateWithinApp}>Open section →</a>
                      : <span className="odos-card-link odos-card-link-off">Not yet available</span>}
                </div>
                {customizing && <button className="odos-card-remove" type="button" aria-label={`Remove ${card.title}`} onClick={() => setCardIds((ids) => ids.filter((item) => item !== card.id))}>×</button>}
              </article>
            );
          })}
        </div>
      </section>

      <div className="odos-dock"><CockpitBadgeDock openPanel={openPanel} onToggle={(id) => setOpenPanel((value) => value === id ? null : id)} /></div>
      {openPanel && <CockpitGuestPanel panel={openPanel} onClose={() => setOpenPanel(null)} />}
      <button className={`odos-scrim ${sectionsOpen ? "is-open" : ""}`} type="button" aria-label="Close sections" onClick={() => setSectionsOpen(false)} />
      <aside className={`odos-sections ${sectionsOpen ? "is-open" : ""}`} aria-label="Sections" aria-hidden={!sectionsOpen}>
        <button className="odos-sections-close" type="button" aria-label="Close sections" onClick={() => setSectionsOpen(false)}>×</button>
        <h2>Sections</h2><p>Everything you don't need every hour — one slide away, never in the way.</p>
        {SECTIONS.map((group) => <section className="odos-section-group" key={group.label}><h3>{group.label}</h3><div className="odos-sections-grid">
          {group.items.map(([title, detail, href]) => href ? <a key={title} href={href} onClick={navigateWithinApp}><strong>{title}</strong><span>{detail}</span></a> : <div key={title} aria-disabled="true"><strong>{title}</strong><span>{detail} · Not yet available</span></div>)}
        </div></section>)}
      </aside>
    </main>
  );
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
    case "schedule": { const value = summary.cards.schedule; return { tone: worstTone([value.today, value.confirmed, value.checkedIn, value.webRequests]), kicker: value.webRequests.value ? `${value.webRequests.value} web requests waiting` : "on track", target: "web requests 0 · confirmations match schedule", content: <><Stats stats={[["Today", value.today], ["Confirmed", value.confirmed], ["Checked in", value.checkedIn], ["Web requests", value.webRequests]]} /><div className="odos-agenda">{value.agenda.map((row, index) => <div key={`${row.time}-${index}`}><time>{row.time}</time><span>{row.patient}</span><em>{row.visitType}</em></div>)}</div></> }; }
    case "attention": { const items = summary.cards.attention.items; return { tone: items[0]?.tone ?? "ok", kicker: items.length ? `${items.length} item${items.length === 1 ? "" : "s"} need you` : "clear", target: "clear by EOD", content: items.length ? <div className="odos-attention-list">{items.map((item) => <div key={item.label} className={`odos-row-tone-${item.tone}`}><TonePip tone={item.tone} /><span><b>{item.label}</b><small>{item.detail}</small></span></div>)}</div> : <p className="odos-all-clear">All clear — nothing needs you.</p> }; }
    case "front-line": return { tone: "off", kicker: "wiring", target: "need reply 0 · urgent handled now", content: <WiringPanel>{summary.cards.frontLine.message}</WiringPanel> };
    case "rx": { const value = summary.cards.pendingRx; return { tone: worstTone([value.spectacle, value.contactLens, value.labOrdersUnsent, value.oldestWaiting]), kicker: value.oldestWaiting.value !== null && value.oldestWaiting.value > 1 ? `${value.oldestWaiting.value}d oldest wait` : "orders moving", target: "oldest waiting ≤ 1 day", content: <Stats stats={[["Spectacle", value.spectacle], ["CL", value.contactLens], ["Lab unsent", value.labOrdersUnsent], ["Oldest", value.oldestWaiting, "d"]]} /> }; }
    case "pickup": { const value = summary.cards.productPickup; return { tone: worstTone([value.openOrders, value.atLab, value.readyNotNotified, value.awaitingPickup]), kicker: value.readyNotNotified.value === null ? "partial contract" : value.readyNotNotified.value ? `${value.readyNotNotified.value} not notified` : "on track", target: "ready-not-notified 0", content: <Stats stats={[["Open orders", value.openOrders], ["At lab", value.atLab], ["Ready, not notified", value.readyNotNotified], ["Awaiting pickup", value.awaitingPickup]]} /> }; }
    case "claims": { const value = summary.cards.claims; return { tone: worstTone([value.failed, value.inProcess, value.paperQueue, value.heldCents, value.lastTransmission]), kicker: value.failed.value ? `${value.failed.value} failed` : value.lastTransmission.tone === "warn" ? "transmission due" : "on track", target: "failed 0 · transmit each business day", content: <Stats stats={[["Failed", value.failed], ["In process", value.inProcess], ["Paper queue", value.paperQueue], ["Held", value.heldCents, "$"], ["Last transmission", value.lastTransmission]]} /> }; }
    case "payments": { const value = summary.cards.payments; return { tone: worstTone([value.unappliedCount, value.unappliedCents, value.patientCreditsOpen, value.patientOpenBalanceCents, value.terminalMode]), kicker: value.terminalMode.value === "TEST MODE" ? "test mode" : value.unappliedCount.value ? `${value.unappliedCount.value} unapplied` : "reconciled", target: "unapplied 0 · live terminal before launch", content: <Stats stats={[["Unapplied", value.unappliedCount], ["Unapplied $", value.unappliedCents, "$"], ["Credits open", value.patientCreditsOpen], ["Open balance", value.patientOpenBalanceCents, "$"], ["Terminal", value.terminalMode]]} /> }; }
    case "remits": { const value = summary.cards.remits; return { tone: worstTone([value.waitingToPost, value.unpostedCents]), kicker: value.waitingToPost.value ? `${value.waitingToPost.value} waiting` : "posted", target: "waiting-to-post 0", content: <Stats stats={[["Waiting to post", value.waitingToPost], ["Unposted", value.unpostedCents, "$"]]} /> }; }
    case "statements": return { tone: "off", kicker: "not yet available", target: "weekly · Wednesday · invalid/rejects 0", content: <WiringPanel>{summary.cards.statements.cadence.value}<br />Last statement arrives with the shipped statement contract.</WiringPanel> };
  }
}

function Stats({ stats }: { stats: Array<[string, DeskStat, string?]> }) {
  return <div className="odos-live-stats">{stats.map(([label, statValue, format]) => <div key={label} className={`odos-stat-tone-${statValue.tone}`} title={statValue.unavailableReason}><span><TonePip tone={statValue.tone} />{label}</span><strong>{displayStat(statValue.value, format)}</strong>{statValue.value === null && <small>Not wired</small>}</div>)}</div>;
}

function TonePip({ tone }: { tone: DeskTone }) { return <i className={`odos-tone-pip odos-pip-${tone}`} aria-label={tone} />; }
function WiringPanel({ children }: { children: ReactNode }) { return <div className="odos-wiring-panel">{children}</div>; }
function displayStat(value: unknown, format?: string): string {
  if (value === null || value === undefined) return "—";
  if (format === "$") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value) / 100);
  return `${value}${format ?? ""}`;
}
function worstTone(stats: DeskStat[]): DeskTone {
  const order: DeskTone[] = ["alert", "warn", "info", "ok", "off"];
  return order.find((tone) => stats.some((item) => item.tone === tone)) ?? "off";
}
