type NavigationLocation = Pick<Location, "href" | "origin">;
type NavigationHistory = Pick<History, "pushState">;

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
  history.pushState({}, "", `${destination.pathname}${destination.search}${destination.hash}`);
  return true;
}
