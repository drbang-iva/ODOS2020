export interface OcucoGatekeeperPinCredentials {
  jwtKey: string;
  jwtSecret: string;
}

export interface OcucoGatekeeperPinRequest {
  baseUrl: string;
  webrxLabId: number;
  pinCode: string;
  fetchImpl?: typeof fetch;
}

export async function requestOcucoGatekeeperPinCredentials(
  input: OcucoGatekeeperPinRequest,
): Promise<OcucoGatekeeperPinCredentials> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl);
  } catch {
    throw new Error("Ocuco Gatekeeper bootstrap requires a valid HTTPS base URL.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new Error("Ocuco Gatekeeper bootstrap requires a valid HTTPS base URL.");
  }
  if (!Number.isSafeInteger(input.webrxLabId) || input.webrxLabId <= 0) {
    throw new Error("Ocuco Gatekeeper bootstrap requires a positive integer webrx_lab_id.");
  }
  if (typeof input.pinCode !== "string" || !input.pinCode.trim()) {
    throw new Error("Ocuco Gatekeeper bootstrap requires a nonblank PIN.");
  }

  const url = new URL("/api/v1/legacy_orders/lab_access_with_pin", baseUrl);
  url.searchParams.set("webrx_lab_id", String(input.webrxLabId));
  url.searchParams.set("pin_code", input.pinCode);

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, { method: "GET" });
  } catch {
    throw new Error("Ocuco Gatekeeper PIN exchange failed before a response was received.");
  }
  if (response.status !== 200) {
    throw new Error(`Ocuco Gatekeeper PIN exchange failed with HTTP ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Ocuco Gatekeeper PIN exchange returned invalid JSON.");
  }
  const lab = record(record(body)?.message)?.lab;
  const jwtKey = record(lab)?.jwt_key;
  const jwtSecret = record(lab)?.jwt_secret;
  if (typeof jwtKey !== "string" || !jwtKey.trim()
    || typeof jwtSecret !== "string" || !jwtSecret.trim()) {
    throw new Error("Ocuco Gatekeeper PIN exchange response is missing jwt_key or jwt_secret.");
  }
  return { jwtKey, jwtSecret };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
