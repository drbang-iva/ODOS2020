import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { CollectTender } from "../../lib/collect";
import type { PackageSaleTender } from "../../lib/commercial-engine";

type SharedTenderCode = [CollectTender] extends [PackageSaleTender]
  ? [PackageSaleTender] extends [CollectTender]
    ? CollectTender
    : never
  : never;

export const TENDERS: ReadonlyArray<{ code: SharedTenderCode; label: string }> = [
  { code: "CASH", label: "Cash" },
  { code: "CHECK", label: "Check" },
  { code: "CARD_MANUAL", label: "Card — manual entry" },
];

interface DockedPanelLayer {
  root: HTMLElement;
  initialFocus: HTMLButtonElement;
  restoreFocus: HTMLElement | null;
  close(): void;
}

const layers: DockedPanelLayer[] = [];
const suppressedElements = new Map<HTMLElement, boolean>();
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDockedPanel(onClose: () => void, active = true) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const reactId = useId();
  const titleId = `docked-panel-title-${reactId.replaceAll(":", "")}`;
  closeRef.current = onClose;

  useBrowserLayoutEffect(() => {
    const root = dialogRef.current;
    const initialFocus = initialFocusRef.current;
    if (!active || !root || !initialFocus) return;
    const layer: DockedPanelLayer = {
      root,
      initialFocus,
      restoreFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      close: () => closeRef.current(),
    };
    layers.push(layer);
    suppressOutsideTopLayer();
    initialFocus.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        layer.close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusableControls(root);
      const last = controls.at(-1);
      if (!last) return;
      if (event.shiftKey && document.activeElement === initialFocus) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        initialFocus.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      suppressOutsideTopLayer();
      layer.restoreFocus?.focus();
    };
  }, [active]);

  return { dialogRef, initialFocusRef, titleId };
}

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((control) => !control.closest("[inert]"));
}

function suppressOutsideTopLayer(): void {
  for (const [element, wasInert] of suppressedElements) element.toggleAttribute("inert", wasInert);
  suppressedElements.clear();
  let current: HTMLElement | null = layers.at(-1)?.root ?? null;
  while (current?.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue;
      suppressedElements.set(sibling, sibling.hasAttribute("inert"));
      sibling.setAttribute("inert", "");
    }
    current = current.parentElement;
  }
}
