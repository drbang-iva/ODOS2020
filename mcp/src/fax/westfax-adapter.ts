export const WESTFAX_BASE_URL = "https://api2.westfax.com";
export const WESTFAX_REQUEST_TIMEOUT_MS = 30_000;
export const WESTFAX_INBOUND_BATCH_SIZE = 25;

export interface WestFaxConfig {
  baseUrl: string;
  username: string;
  password: string;
  productId: string;
  callbackBaseUrl: string;
}

export interface FaxSendInput {
  destinationNumbers: string[];
  files: Array<{ content: Buffer | string; filename: string }>;
  billingCode?: string;
  header?: string;
  feedbackEmail?: string;
  faxQuality?: "Fine" | "Normal";
  callbackUrl?: string;
}

export interface FaxSendResult {
  success: boolean;
  jobId?: string;
  errorString?: string;
  infoString?: string;
}

export interface WestFaxInboundProduct {
  id: string;
  inboundNumber?: string;
}

export interface WestFaxFaxIdentifier {
  id: string;
  direction: "Inbound";
  date?: string;
  tag?: string;
}

export interface WestFaxFaxDescription extends WestFaxFaxIdentifier {
  pageCount?: number;
  senderNumber?: string;
  reference?: string;
}

export interface WestFaxFaxDocument extends WestFaxFaxIdentifier {
  pageCount?: number;
  contentType: "application/pdf";
  fileContents: string;
}

export interface WestFaxAdapter {
  sendFax(input: FaxSendInput): Promise<FaxSendResult>;
  getProductsWithInboundFaxes(filter: "None"): Promise<WestFaxInboundProduct[]>;
  getFaxIdentifiers(
    productId: string,
    direction: "Inbound",
  ): Promise<WestFaxFaxIdentifier[]>;
  getFaxDescriptions(
    productId: string,
    faxIds: WestFaxFaxIdentifier[],
  ): Promise<WestFaxFaxDescription[]>;
  getFaxDocuments(
    productId: string,
    faxIds: WestFaxFaxIdentifier[],
    format: "pdf",
  ): Promise<WestFaxFaxDocument[]>;
  changeFaxFilterValue(
    productId: string,
    faxIds: WestFaxFaxIdentifier[],
    filter: "Retrieved",
  ): Promise<void>;
}

interface WestFaxResponse {
  Success?: boolean;
  Result?: unknown;
  ErrorString?: unknown;
  InfoString?: unknown;
}

export function westFaxConfigFromEnv(
  env: Record<string, string | undefined>,
): WestFaxConfig | null {
  const names = [
    "WESTFAX_USERNAME",
    "WESTFAX_PASSWORD",
    "WESTFAX_PRODUCT_ID",
    "WESTFAX_CALLBACK_BASE_URL",
    "WESTFAX_BASE_URL",
  ] as const;
  if (!names.some((name) => Boolean(env[name]))) return null;

  const required = [
    "WESTFAX_USERNAME",
    "WESTFAX_PASSWORD",
    "WESTFAX_PRODUCT_ID",
    "WESTFAX_CALLBACK_BASE_URL",
  ] as const;
  const missing = required.find((name) => !env[name]?.trim());
  if (missing) {
    throw new Error(`WestFax adapter is partially configured — missing ${missing}.`);
  }

  return {
    username: env.WESTFAX_USERNAME!.trim(),
    password: env.WESTFAX_PASSWORD!,
    productId: env.WESTFAX_PRODUCT_ID!.trim(),
    baseUrl: secureBaseUrl(env.WESTFAX_BASE_URL ?? WESTFAX_BASE_URL, "WESTFAX_BASE_URL"),
    callbackBaseUrl: secureBaseUrl(
      env.WESTFAX_CALLBACK_BASE_URL!,
      "WESTFAX_CALLBACK_BASE_URL",
    ),
  };
}

export function createWestFaxAdapter(
  config: WestFaxConfig,
  deps: { fetchImpl?: typeof fetch } = {},
): WestFaxAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = secureBaseUrl(config.baseUrl, "WestFax baseUrl");

  return {
    async sendFax(input) {
      if (!input.destinationNumbers.length) {
        throw new Error("WestFax requires at least one destination number.");
      }
      if (!input.files.length) {
        throw new Error("WestFax requires at least one outbound file.");
      }

      const form = new FormData();
      form.set("Username", config.username);
      form.set("Password", config.password);
      form.set("Cookies", "false");
      form.set("ProductId", config.productId);
      input.destinationNumbers.forEach((number, index) => {
        const normalized = number.trim();
        if (!normalized) throw new Error("WestFax destination numbers cannot be blank.");
        form.set(`Numbers${index + 1}`, normalized);
      });
      input.files.forEach((file, index) => {
        const filename = file.filename.trim();
        if (!filename) throw new Error("WestFax outbound filenames cannot be blank.");
        const bytes = typeof file.content === "string"
          ? Uint8Array.from(Buffer.from(file.content, "base64"))
          : Uint8Array.from(file.content);
        form.set(
          `Files${index}`,
          new Blob([bytes], { type: contentType(filename) }),
          filename,
        );
      });
      optional(form, "BillingCode", input.billingCode);
      optional(form, "Header", input.header);
      optional(form, "FeedbackEmail", input.feedbackEmail);
      optional(form, "FaxQuality", input.faxQuality);
      optional(form, "CallbackUrl", input.callbackUrl);

      const { response, raw } = await postWestFax(
        fetchImpl,
        baseUrl,
        "Fax_SendFax",
        form,
      );
      const jobId = stringValue(raw.Result);
      return {
        success: response.ok && raw.Success === true,
        ...(jobId ? { jobId } : {}),
        ...(stringValue(raw.ErrorString) ? { errorString: stringValue(raw.ErrorString) } : {}),
        ...(stringValue(raw.InfoString) ? { infoString: stringValue(raw.InfoString) } : {}),
      };
    },

    async getProductsWithInboundFaxes(filter) {
      const form = authForm(config);
      form.set("Filter", filter);
      const raw = await successfulWestFaxCall(
        fetchImpl,
        baseUrl,
        "Fax_GetProductsWithInboundFaxes",
        form,
      );
      return resultArray(raw).flatMap((value) => {
        const row = objectValue(value);
        const id = stringValue(row?.Id);
        if (!id) return [];
        const inboundNumber = stringValue(row?.InboundNumber);
        return [{ id, ...(inboundNumber ? { inboundNumber } : {}) }];
      });
    },

    async getFaxIdentifiers(productId, direction) {
      const form = authForm(config, productId);
      form.set("FaxDirection", direction);
      const raw = await successfulWestFaxCall(
        fetchImpl,
        baseUrl,
        "Fax_GetFaxIdentifiers",
        form,
      );
      return resultArray(raw).flatMap((value) => {
        const row = objectValue(value);
        const id = stringValue(row?.Id);
        if (!id || row?.Direction !== "Inbound") return [];
        return [{
          id,
          direction: "Inbound" as const,
          ...(stringValue(row.Date) ? { date: stringValue(row.Date) } : {}),
          ...(stringValue(row.Tag) ? { tag: stringValue(row.Tag) } : {}),
        }];
      });
    },

    async getFaxDescriptions(productId, faxIds) {
      if (!faxIds.length) return [];
      const descriptions: WestFaxFaxDescription[] = [];
      for (const batch of batches(faxIds, WESTFAX_INBOUND_BATCH_SIZE)) {
        const form = authForm(config, productId);
        addFaxIds(form, batch);
        const raw = await successfulWestFaxCall(
          fetchImpl,
          baseUrl,
          "Fax_GetFaxDescriptionsUsingIds",
          form,
        );
        descriptions.push(...resultArray(raw).flatMap((value) => {
          const row = objectValue(value);
          const id = stringValue(row?.Id);
          if (!id || row?.Direction !== "Inbound") return [];
          const call = Array.isArray(row.FaxCallInfoList)
            ? objectValue(row.FaxCallInfoList[0])
            : undefined;
          const senderNumber = stringValue(call?.OrigNumber);
          const pageCount = integerValue(row.PageCount);
          return [{
            id,
            direction: "Inbound" as const,
            ...(stringValue(row.Date) ? { date: stringValue(row.Date) } : {}),
            ...(stringValue(row.Tag) ? { tag: stringValue(row.Tag) } : {}),
            ...(pageCount !== undefined ? { pageCount } : {}),
            ...(senderNumber ? { senderNumber } : {}),
            ...(stringValue(row.Reference) ? { reference: stringValue(row.Reference) } : {}),
          }];
        }));
      }
      return descriptions;
    },

    async getFaxDocuments(productId, faxIds, format) {
      if (!faxIds.length) return [];
      const documents: WestFaxFaxDocument[] = [];
      for (const batch of batches(faxIds, WESTFAX_INBOUND_BATCH_SIZE)) {
        const form = authForm(config, productId);
        addFaxIds(form, batch);
        form.set("Format", format);
        const raw = await successfulWestFaxCall(
          fetchImpl,
          baseUrl,
          "Fax_GetFaxDocuments",
          form,
        );
        documents.push(...resultArray(raw).flatMap((value) => {
          const row = objectValue(value);
          const id = stringValue(row?.Id);
          if (!id || row?.Direction !== "Inbound") return [];
          if (!Array.isArray(row.FaxFiles) || row.FaxFiles.length !== 1) {
            throw new Error(
              `WestFax fax ${id} must contain exactly one PDF file; received ${Array.isArray(row.FaxFiles) ? row.FaxFiles.length : 0}.`,
            );
          }
          const file = objectValue(row.FaxFiles[0]);
          const fileContents = stringValue(file?.FileContents);
          if (file?.ContentType !== "application/pdf" || !fileContents) return [];
          const pageCount = integerValue(row.PageCount);
          return [{
            id,
            direction: "Inbound" as const,
            ...(stringValue(row.Date) ? { date: stringValue(row.Date) } : {}),
            ...(stringValue(row.Tag) ? { tag: stringValue(row.Tag) } : {}),
            ...(pageCount !== undefined ? { pageCount } : {}),
            contentType: "application/pdf" as const,
            fileContents,
          }];
        }));
      }
      return documents;
    },

    async changeFaxFilterValue(productId, faxIds, filter) {
      if (!faxIds.length) return;
      const form = authForm(config, productId);
      addFaxIds(form, faxIds);
      form.set("Filter", filter);
      const raw = await successfulWestFaxCall(
        fetchImpl,
        baseUrl,
        "Fax_ChangeFaxFilterValue",
        form,
      );
      if (raw.Result !== true) {
        throw new Error("WestFax did not confirm the inbound fax filter update.");
      }
    },
  };
}

function authForm(config: WestFaxConfig, productId?: string): FormData {
  const form = new FormData();
  form.set("Username", config.username);
  form.set("Password", config.password);
  form.set("Cookies", "false");
  if (productId) form.set("ProductId", productId);
  return form;
}

function addFaxIds(form: FormData, faxIds: WestFaxFaxIdentifier[]): void {
  faxIds.forEach((faxId, index) => {
    form.set(`FaxIds${index + 1}`, JSON.stringify({
      Id: faxId.id,
      Direction: faxId.direction,
    }));
  });
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function successfulWestFaxCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  method: string,
  form: FormData,
): Promise<WestFaxResponse> {
  const { response, raw } = await postWestFax(fetchImpl, baseUrl, method, form);
  if (!response.ok || raw.Success !== true) {
    const detail = stringValue(raw.ErrorString)
      ?? stringValue(raw.InfoString)
      ?? `HTTP ${response.status}`;
    throw new Error(`WestFax ${method} failed: ${detail}`);
  }
  return raw;
}

async function postWestFax(
  fetchImpl: typeof fetch,
  baseUrl: string,
  method: string,
  form: FormData,
): Promise<{ response: Response; raw: WestFaxResponse }> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WESTFAX_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/REST/${method}/json`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
      signal: controller.signal,
    });
    return { response, raw: await parseResponse(response) };
  } catch (error) {
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new Error("WestFax request timed out after 30 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resultArray(raw: WestFaxResponse): unknown[] {
  return Array.isArray(raw.Result) ? raw.Result : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function optional(form: FormData, name: string, value: string | undefined): void {
  if (value?.trim()) form.set(name, value.trim());
}

function secureBaseUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS because it receives WestFax credentials or callbacks.`);
  }
  return value.replace(/\/$/, "");
}

async function parseResponse(response: Response): Promise<WestFaxResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as WestFaxResponse;
  } catch {
    return {
      Success: false,
      ErrorString: `WestFax returned HTTP ${response.status} with a non-JSON response.`,
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contentType(filename: string): string {
  return filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
}
