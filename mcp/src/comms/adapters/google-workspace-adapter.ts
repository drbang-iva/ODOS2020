import { createSign } from "node:crypto";
import type {
  CommsProvider,
  SendEmailRequest,
  SendResult,
} from "../comms-provider.js";

/**
 * Gmail API send-only adapter using a service account with Workspace domain-wide delegation.
 *
 * Verified 2026-07-30 against Google's current primary documentation:
 * - Domain-wide delegation lets a Super Admin authorize unattended Gmail API sends without
 *   individual user consent:
 *   https://developers.google.com/workspace/guides/create-credentials#domain-wide_delegation
 * - The delegated JWT names the impersonated Workspace user in `sub`:
 *   https://developers.google.com/identity/protocols/oauth2/service-account
 * - `users.messages.send` accepts base64url MIME and the least-privilege send scope below:
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 *   https://developers.google.com/workspace/gmail/api/auth/scopes
 * - Google's Workspace limits page currently reports 2,000 messages per user in a rolling
 *   24-hour period, but this is PROVISIONAL because the API quota page documents different
 *   rate limits rather than independently corroborating the mailbox limit:
 *   https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace
 *   https://developers.google.com/workspace/gmail/api/reference/quota
 *
 * Gmail API was chosen over SMTP relay because `gmail.send` is a narrow send-only permission and
 * `users.messages.send` returns a provider message id for the FHIR Communication record.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

export interface GoogleWorkspaceAdapterConfig {
  serviceAccountEmail: string;
  privateKey: string;
  delegatedUserEmail: string;
  workspaceDomain: string;
  fromAddress: string;
  workspacePlanConfirmed?: boolean;
  tokenUrl?: string;
  gmailBaseUrl?: string;
}

export interface GoogleWorkspaceAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  warn?: (message: string) => void;
}

interface AccessTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface GmailSendResponse {
  id?: unknown;
  threadId?: unknown;
  error?: unknown;
}

export function createGoogleWorkspaceAdapter(
  config: GoogleWorkspaceAdapterConfig,
  deps: GoogleWorkspaceAdapterDeps = {},
): CommsProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const normalized = validateConfig(config);
  let cachedToken: { value: string; expiresAt: number } | undefined;

  if (
    normalized.workspaceDomain === "gmail.com"
    || normalized.workspaceDomain === "googlemail.com"
    || normalized.workspacePlanConfirmed !== true
  ) {
    warn(
      "ODOS communications: paid Google Workspace and BAA acceptance are not API-verifiable. "
      + "This configuration appears to use personal Gmail or lacks operator confirmation; "
      + "confirm a paid Workspace plan and accepted BAA before sending patient information.",
    );
  }

  async function accessToken(): Promise<string> {
    const nowMs = now().getTime();
    if (cachedToken && cachedToken.expiresAt - 60_000 > nowMs) {
      return cachedToken.value;
    }
    const assertion = serviceAccountAssertion(normalized, Math.floor(nowMs / 1000));
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await fetchImpl(normalized.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const parsed = await json<AccessTokenResponse>(response);
    if (!response.ok || typeof parsed.access_token !== "string") {
      throw new Error(
        `Google Workspace token exchange failed (HTTP ${response.status}): ${errorDetail(parsed)}`,
      );
    }
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    cachedToken = {
      value: parsed.access_token,
      expiresAt: nowMs + Math.max(1, expiresIn) * 1000,
    };
    return cachedToken.value;
  }

  return {
    name: "google-workspace",
    capabilities: {
      sms: false,
      calls: false,
      email: true,
      contacts: false,
      conversations: false,
      reviews: false,
    },

    async sendEmail(request: SendEmailRequest): Promise<SendResult> {
      const toAddress = requiredEmail(request.toAddress, "Patient email address");
      assertNoHeaderInjection(request.subject, "Email subject");
      assertNoHeaderInjection(toAddress, "Patient email address");
      const raw = Buffer.from(
        [
          `From: ${normalized.fromAddress}`,
          `To: ${toAddress}`,
          `Subject: ${request.subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 8bit",
          "",
          request.body,
        ].join("\r\n"),
        "utf8",
      ).toString("base64url");
      const token = await accessToken();
      const response = await fetchImpl(
        `${normalized.gmailBaseUrl}/users/${encodeURIComponent(normalized.delegatedUserEmail)}/messages/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        },
      );
      const parsed = await json<GmailSendResponse>(response);
      if (!response.ok || typeof parsed.id !== "string") {
        throw new Error(
          `Google Workspace Gmail send failed (HTTP ${response.status}): ${errorDetail(parsed)}`,
        );
      }
      return {
        outcome: "sent",
        providerMessageId: parsed.id,
        ...(typeof parsed.threadId === "string" ? { providerThreadId: parsed.threadId } : {}),
      };
    },
  };
}

function validateConfig(config: GoogleWorkspaceAdapterConfig) {
  const serviceAccountEmail = requiredEmail(
    config.serviceAccountEmail,
    "Google Workspace service account email",
  );
  const delegatedUserEmail = requiredEmail(
    config.delegatedUserEmail,
    "Google Workspace delegated user",
  );
  const fromAddress = requiredEmail(config.fromAddress, "Google Workspace from address");
  const workspaceDomain = config.workspaceDomain.trim().toLowerCase();
  if (!workspaceDomain || workspaceDomain.includes("@") || workspaceDomain.includes("/")) {
    throw new Error("Google Workspace domain must be a bare domain name.");
  }
  if (!delegatedUserEmail.toLowerCase().endsWith(`@${workspaceDomain}`)) {
    throw new Error("Google Workspace delegated user must belong to the configured Workspace domain.");
  }
  if (!config.privateKey.trim()) {
    throw new Error("Google Workspace service account private key is required.");
  }
  return {
    serviceAccountEmail,
    privateKey: config.privateKey.replaceAll("\\n", "\n"),
    delegatedUserEmail,
    workspaceDomain,
    fromAddress,
    workspacePlanConfirmed: config.workspacePlanConfirmed,
    tokenUrl: secureUrl(config.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL, "Google OAuth token URL"),
    gmailBaseUrl: secureUrl(config.gmailBaseUrl ?? GMAIL_API_BASE_URL, "Gmail API base URL"),
  };
}

function serviceAccountAssertion(
  config: ReturnType<typeof validateConfig>,
  issuedAt: number,
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({
      iss: config.serviceAccountEmail,
      sub: config.delegatedUserEmail,
      scope: GMAIL_SEND_SCOPE,
      aud: config.tokenUrl,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ].join(".");
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(config.privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

function requiredEmail(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error(`${label} must be a valid email address.`);
  }
  return normalized;
}

function assertNoHeaderInjection(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain email header line breaks.`);
  }
}

function secureUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  return value.replace(/\/$/, "");
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Google Workspace returned HTTP ${response.status} with a non-JSON response.`);
  }
}

function errorDetail(value: { error?: unknown; error_description?: unknown }): string {
  if (typeof value.error_description === "string") return value.error_description;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object" && "message" in value.error) {
    const message = value.error.message;
    if (typeof message === "string") return message;
  }
  return "provider response did not include a usable error";
}
