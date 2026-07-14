type NavigationLocation = Pick<Location, "href" | "origin">;
type NavigationHistory = Pick<History, "pushState">;

export function requiresFullPageNavigation(pathname: string): boolean {
  return pathname.startsWith("/setpassword/")
    || pathname === "/oauth2/authorize"
    || pathname === "/oauth2/grants";
}

export function interceptAppNavigation(
  event: MouseEvent,
  location: NavigationLocation = window.location,
  history: NavigationHistory = window.history,
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

  event.preventDefault();
  history.pushState({}, "", `${destination.pathname}${destination.search}${destination.hash}`);
  return true;
}
