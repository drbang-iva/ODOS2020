import clsx from "clsx";
import { useEffect, useRef, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { dockItem, type CockpitPanelId } from "../../lib/cockpit-shell";

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

export function loadCockpitPanelPosition(storage: Pick<CockpitPositionStorage, "getItem"> | undefined = browserStorage(), storageKey = COCKPIT_PANEL_POSITION_STORAGE_KEY): CockpitPanelPosition | null {
  try {
    const value = JSON.parse(storage?.getItem(storageKey) ?? "null") as Partial<CockpitPanelPosition> | null;
    return value?.floating === true && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { floating: true, x: value.x!, y: value.y! }
      : null;
  } catch {
    return null;
  }
}

export function saveCockpitPanelPosition(position: CockpitPanelPosition, storage: Pick<CockpitPositionStorage, "setItem"> | undefined = browserStorage(), storageKey = COCKPIT_PANEL_POSITION_STORAGE_KEY): void {
  try {
    storage?.setItem(storageKey, JSON.stringify(position));
  } catch {
    return;
  }
}

export function clearCockpitPanelPosition(storage: Pick<CockpitPositionStorage, "removeItem"> | undefined = browserStorage(), storageKey = COCKPIT_PANEL_POSITION_STORAGE_KEY): void {
  try {
    storage?.removeItem(storageKey);
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
  children,
  title,
  documentPreview = false,
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
  children?: ReactNode;
  title?: string;
  documentPreview?: boolean;
}) {
  const item = dockItem(panel);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open && documentPreview) closeButtonRef.current?.focus();
  }, [open, documentPreview]);
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
      aria-label={title ?? item.label}
      aria-hidden={!open}
      onPointerEnter={(event) => event.pointerType !== "touch" && onHoverEnter?.()}
      onPointerLeave={(event) => event.pointerType !== "touch" && onHoverLeave?.()}
      className={clsx(
        "odos-cockpit-panel fixed z-40 flex flex-col overflow-hidden border border-white/15 bg-[#0c0c18] shadow-2xl",
        open && "is-open",
        documentPreview && "odos-cockpit-panel-document",
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
        <span className="text-sm font-bold text-white">{title ?? item.label}</span>
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
            ref={closeButtonRef}
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
        {children ?? PANEL_STUB[panel]}
      </div>
    </aside>
  );
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
