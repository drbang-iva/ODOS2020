import { useEffect, useState, type MouseEvent } from "react";
import { CockpitBadgeDock } from "./frontdesk/CockpitBadgeDock";
import { CockpitGuestPanel } from "./frontdesk/CockpitGuestPanel";
import type { CockpitPanelId } from "../lib/cockpit-shell";

export const DESK_LABEL = "Desk";
export const DESK_HOME_PATH = "/desk";
export const CLINIC_PATH = "/clinic";
export const DESK_CARD_STORAGE_KEY = "osod.desk.cards.v1";

export const DESK_CARDS = [
  { id: "schedule", title: "Today's schedule", summary: "Schedule and floor status", href: "/frontdesk", tone: "sapphire", span: "wide" },
  { id: "attention", title: "Needs attention", summary: "Items requiring staff review", href: "/billing/claims/worklist", tone: "amber", span: "standard" },
  { id: "rx", title: "Pending Rx", summary: "Open optical orders", href: "/dispensary/orders", tone: "emerald", span: "standard" },
  { id: "pickup", title: "Product pickup", summary: "Orders and dispensing", href: "/dispensary/orders", tone: "emerald", span: "standard" },
  { id: "claims", title: "Claims", summary: "Claim worklists and follow-up", href: "/billing/claims/worklist", tone: "amethyst", span: "standard" },
  { id: "payments", title: "Payments", summary: "Patient and carrier payments", href: "/billing/claims/patient-payments", tone: "amethyst", span: "standard" },
  { id: "remits", title: "Electronic remits", summary: "Remittance posting queue", href: "/billing/claims/remittances", tone: "amethyst", span: "half" },
  { id: "statements", title: "Statements", summary: "Statement workflow is not shipped yet", tone: "amethyst", span: "half" },
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

function navigateWithinApp(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.history.pushState({}, "", event.currentTarget.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function initialCardIds(): DeskCardId[] {
  if (typeof window === "undefined") return [...DEFAULT_CARD_IDS];
  const stored = window.localStorage.getItem(DESK_CARD_STORAGE_KEY);
  if (!stored) return [...DEFAULT_CARD_IDS];
  try {
    return sanitizeDeskCardIds(JSON.parse(stored));
  } catch {
    return [...DEFAULT_CARD_IDS];
  }
}

const SECTIONS = [
  ["Reports", "Sales, production, and aging", "/billing/claims/reports/accounts-receivable"],
  ["Statements & letters", "Patient statements and batch letters", ""],
  ["Claims workbench", "Transmission, remits, and denial worklists", "/billing/claims/worklist"],
  ["Catalog & pricing", "Frames catalog and pricing", "/admin/optical/catalog/frames"],
  ["Inventory", "Frames inventory and adjustments", "/admin/optical/inventory/frames"],
  ["Patient recall", "Recall workflow", ""],
  ["Administration", "Practice configuration", "/settings"],
  ["Integrations", "Frames Data and connected services", "/admin/practice/settings/frames-data"],
  ["Audit log", "Every access and change", "/audit/log"],
] as const;

export function DeskHome() {
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [cardIds, setCardIds] = useState<DeskCardId[]>(initialCardIds);
  const [dragged, setDragged] = useState<DeskCardId | null>(null);
  const [openPanel, setOpenPanel] = useState<CockpitPanelId | null>(null);

  useEffect(() => {
    window.localStorage.setItem(DESK_CARD_STORAGE_KEY, JSON.stringify(cardIds));
  }, [cardIds]);

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
        <span className="odos-location">Practice home</span>
        <div className="odos-topbar-spacer" />
        <button className="odos-pill" type="button" onClick={() => setCustomizing((value) => !value)} aria-pressed={customizing}>Customize</button>
        <button className="odos-pill" type="button" onClick={() => setSectionsOpen(true)}>Sections</button>
        <a className="odos-pill odos-clinic-pill" href={CLINIC_PATH} target="_blank" rel="noopener noreferrer">Clinic <span aria-hidden>↗</span></a>
      </header>

      <section className="odos-desk-body">
        <div className="odos-desk-greeting">
          <h1>Good day.</h1>
          <span>{date}</span>
          <span className="odos-mode">The {DESK_LABEL}</span>
        </div>

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
            const content = (
              <>
                <span className="odos-card-edge" />
                <span className="odos-card-kicker">{card.title}</span>
                <strong>{card.summary}</strong>
                <span className="odos-card-action">{"href" in card ? "Open section →" : "Not yet available"}</span>
              </>
            );
            return (
              <article
                key={card.id}
                className={`odos-desk-card odos-tone-${card.tone} odos-span-${card.span}`}
                draggable={customizing}
                onDragStart={() => setDragged(card.id)}
                onDragOver={(event) => customizing && event.preventDefault()}
                onDrop={() => { if (dragged) setCardIds((ids) => reorderDeskCards(ids, dragged, card.id)); setDragged(null); }}
              >
                {"href" in card ? <a href={card.href} onClick={navigateWithinApp}>{content}</a> : <div>{content}</div>}
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
        <h2>Sections</h2>
        <p>Everything you don't need every hour — one slide away, never in the way.</p>
        <div className="odos-sections-grid">
          {SECTIONS.map(([title, detail, href]) => href ? <a key={title} href={href} onClick={navigateWithinApp}><strong>{title}</strong><span>{detail}</span></a> : <div key={title} aria-disabled="true"><strong>{title}</strong><span>{detail} · Not yet available</span></div>)}
        </div>
      </aside>
    </main>
  );
}
