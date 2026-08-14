type NavigationLocation = Pick<Location, "href" | "origin">;
type NavigationHistory = Pick<History, "pushState"> & Partial<Pick<History, "state" | "replaceState" | "go">>;

const APP_HISTORY_INDEX = "__odosHistoryIndex";

const navigationBlockers = new Set<() => boolean>();
let confirmedProgrammaticNavigation = false;

export function registerNavigationBlocker(blocker: () => boolean): () => void {
  navigationBlockers.add(blocker);
  return () => navigationBlockers.delete(blocker);
}

export function confirmAppNavigation(
  confirm: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  if (![...navigationBlockers].some((blocker) => blocker())) return true;
  return confirm("You have unsaved settings changes. Leave without saving them?");
}

export function markProgrammaticNavigationConfirmed(): void {
  confirmedProgrammaticNavigation = true;
}

export function confirmPopstateNavigation(
  confirm?: (message: string) => boolean,
): boolean {
  if (confirmedProgrammaticNavigation) {
    confirmedProgrammaticNavigation = false;
    return true;
  }
  return confirmAppNavigation(confirm);
}

export function requiresFullPageNavigation(pathname: string): boolean {
  return pathname.startsWith("/setpassword/")
    || pathname === "/oauth2/authorize"
    || pathname === "/oauth2/grants";
}

export function appHistoryIndex(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>)[APP_HISTORY_INDEX];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function initializeAppHistory(
  history: NavigationHistory = window.history,
  url?: string | URL | null,
): number {
  const existing = appHistoryIndex(history.state);
  if (existing !== undefined) return existing;
  const index = 0;
  history.replaceState?.(withHistoryIndex(history.state, index), "", url);
  return index;
}

export function pushAppHistory(
  history: NavigationHistory,
  url: string | URL | null,
): number {
  const nextIndex = (appHistoryIndex(history.state) ?? 0) + 1;
  history.pushState(withHistoryIndex(history.state, nextIndex), "", url);
  return nextIndex;
}

export function restoreCancelledHistoryNavigation(
  history: NavigationHistory,
  priorIndex: number,
  targetState: unknown,
): boolean {
  const targetIndex = appHistoryIndex(targetState);
  if (targetIndex === undefined || !history.go) return false;
  const delta = priorIndex - targetIndex;
  if (delta === 0) return false;
  history.go(delta);
  return true;
}

export function interceptAppNavigation(
  event: MouseEvent,
  location: NavigationLocation = window.location,
  history: NavigationHistory = window.history,
  allowNavigation: () => boolean = confirmAppNavigation,
): boolean {
  if (event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey) return false;

  const target = event.target as (EventTarget & { closest?: (selector: string) => Element | null }) | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null | undefined;
  if (!anchor
    || anchor.hasAttribute("download")
    || anchor.hasAttribute("data-native")
    || (anchor.target && anchor.target.toLowerCase() !== "_self")) return false;

  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;

  const destination = new URL(href, location.href);
  if (destination.origin !== location.origin || requiresFullPageNavigation(destination.pathname)) return false;

  if (!allowNavigation()) {
    event.preventDefault();
    return false;
  }

  event.preventDefault();
  pushAppHistory(history, `${destination.pathname}${destination.search}${destination.hash}`);
  return true;
}

function withHistoryIndex(state: unknown, index: number): Record<string, unknown> {
  return {
    ...(state && typeof state === "object" ? state as Record<string, unknown> : {}),
    [APP_HISTORY_INDEX]: index,
  };
}
