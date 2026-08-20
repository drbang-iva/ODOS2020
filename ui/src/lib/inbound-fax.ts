import { fhir } from "./fhir";

export type InboundFaxAction = "attach" | "promote" | "inbox";

export async function triageInboundFax(
  faxId: string,
  action: InboundFaxAction,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `/fax/inbound/${encodeURIComponent(faxId)}/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `Inbound fax action failed with HTTP ${response.status}.`);
  }
}

export async function openInboundFaxDocument(
  documentUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!isSameOriginDocumentUrl(documentUrl)) {
    throw new Error("Inbound fax document URL must be same-origin.");
  }
  const authorization = fhir.authHeader();
  const response = await fetchImpl(documentUrl, {
    headers: {
      Accept: "application/pdf",
      ...(authorization ? { Authorization: authorization } : {}),
    },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error ?? `Inbound fax document failed with HTTP ${response.status}.`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function isSameOriginDocumentUrl(documentUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(documentUrl, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
