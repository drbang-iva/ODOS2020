export const WESTFAX_BASE_URL = "https://api2.westfax.com";
export const WESTFAX_REQUEST_TIMEOUT_MS = 30_000;

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

export interface WestFaxAdapter {
  sendFax(input: FaxSendInput): Promise<FaxSendResult>;
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

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, WESTFAX_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${baseUrl}/REST/Fax_SendFax/json`, {
          method: "POST",
          headers: { Accept: "application/json" },
          body: form,
          signal: controller.signal,
        });
        const raw = await parseResponse(response);
        const jobId = stringValue(raw.Result);
        return {
          success: response.ok && raw.Success === true,
          ...(jobId ? { jobId } : {}),
          ...(stringValue(raw.ErrorString) ? { errorString: stringValue(raw.ErrorString) } : {}),
          ...(stringValue(raw.InfoString) ? { infoString: stringValue(raw.InfoString) } : {}),
        };
      } catch (error) {
        if (timedOut && error instanceof Error && error.name === "AbortError") {
          throw new Error("WestFax request timed out after 30 seconds.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
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
