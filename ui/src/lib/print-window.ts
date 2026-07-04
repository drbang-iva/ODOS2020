type PrintableWindow = Pick<Window, "document">;

export type PrintWindowOpener = (url: string, target: string, features: string) => PrintableWindow | null;

export function openPrintWindow(
  title: string,
  html: string,
  opener: PrintWindowOpener = (url, target, features) => window.open(url, target, features),
): boolean {
  const printWindow = opener("", "_blank", "noopener,noreferrer");
  if (!printWindow) return false;
  printWindow.document.open();
  printWindow.document.write(
    `<!doctype html><html><head><title>${escapeDocumentTitle(title)}</title></head><body>${html}<script>window.addEventListener("load", function () { window.focus(); window.print(); });<\/script></body></html>`,
  );
  printWindow.document.close();
  return true;
}

function escapeDocumentTitle(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
}
