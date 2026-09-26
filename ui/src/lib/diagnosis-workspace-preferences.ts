const IMAGING_OPEN_KEY = "odos:diagnosis-imaging-open";

export function loadDiagnosisImagingOpen(storage = browserStorage()): boolean {
  const value = storage?.getItem(IMAGING_OPEN_KEY);
  return value === "false" ? false : true;
}

export function saveDiagnosisImagingOpen(
  open: boolean,
  storage = browserStorage(),
): void {
  storage?.setItem(IMAGING_OPEN_KEY, String(open));
}

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
