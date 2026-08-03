import type { Patient } from "@medplum/fhirtypes";
import {
  createGhlAdapter,
  type GhlAdapterConfig,
} from "./adapters/ghl-adapter.js";
import {
  createGoogleWorkspaceAdapter,
  type GoogleWorkspaceAdapterConfig,
} from "./adapters/google-workspace-adapter.js";
import {
  createTwilioAdapter,
  type TwilioAdapterConfig,
  type TwilioClientFactory,
  withTwilioConversationStore,
} from "./adapters/twilio-adapter.js";
import type { CommsProvider } from "./comms-provider.js";
import {
  createSuppressedCommsProvider,
  type SuppressionFhir,
} from "./suppression-gate.js";

export type CommsAdapterRegistration =
  | {
      provider: "google-workspace";
      config: GoogleWorkspaceAdapterConfig;
    }
  | {
      provider: "twilio";
      config: TwilioAdapterConfig;
    }
  | {
      provider: "ghl";
      config: GhlAdapterConfig;
    };

export interface CommsDispatchDeps {
  error?: (message: string) => void;
  fetchImpl?: typeof fetch;
  info?: (message: string) => void;
  now?: () => Date;
  warn?: (message: string) => void;
  practiceTimeZone?: string;
  twilioClientFactory?: TwilioClientFactory;
}

export type CommsDispatchFhir = SuppressionFhir;

export interface CommsDispatch {
  initialize(): Promise<void>;
  getAdapter(provider: string, callerFhir: CommsDispatchFhir): CommsProvider;
  providers(): string[];
}

export async function startMcpAfterCommsInitialization(
  dispatch: Pick<CommsDispatch, "initialize">,
  startServer: () => Promise<void>,
): Promise<void> {
  await dispatch.initialize();
  await startServer();
}

export function createCommsDispatch(
  registrations: CommsAdapterRegistration[],
  deps: CommsDispatchDeps = {},
): CommsDispatch {
  const byProvider = new Map<string, CommsAdapterRegistration>(
    registrations.map((registration) => [registration.provider, registration]),
  );
  const adapters = new Map<string, CommsProvider>();
  const getTwilioAdapter = (
    registration: Extract<CommsAdapterRegistration, { provider: "twilio" }>,
  ) => {
    let adapter = adapters.get(registration.provider);
    if (!adapter) {
      adapter = createTwilioAdapter(registration.config, {
        fetchImpl: deps.fetchImpl,
        clientFactory: deps.twilioClientFactory,
        now: deps.now,
      });
      adapters.set(registration.provider, adapter);
    }
    return adapter as ReturnType<typeof createTwilioAdapter>;
  };
  return {
    async initialize() {
      for (const registration of byProvider.values()) {
        if (registration.provider !== "twilio") continue;
        const info = deps.info ?? console.error;
        info(registration.config.hipaaMode
          ? "odos-mcp: Twilio HIPAA posture ENABLED; US-only destinations and senders are enforced."
          : "odos-mcp: Twilio HIPAA posture DISABLED; international destinations and senders are permitted.");
        try {
          await getTwilioAdapter(registration).initialize();
        } catch (error) {
          const reasons: string[] = [];
          const seen = new Set<unknown>();
          let current: unknown = error;
          while (current instanceof Error && !seen.has(current)) {
            seen.add(current);
            reasons.push(current.message);
            current = current.cause;
          }
          (deps.error ?? console.error)(
            `odos-mcp: communications provider "twilio" DEGRADED; Twilio SMS remains disabled while ODOS continues starting. Reason: ${reasons.join(" Caused by: ") || "unknown initialization failure"} Remediation: verify Twilio API availability and grant the Restricted Messaging key permission twilio/messaging/services.phonenumbers/list, then restart ODOS.`,
          );
        }
      }
    },
    providers() {
      return [...byProvider.keys()];
    },
    getAdapter(provider: string, callerFhir: SuppressionFhir): CommsProvider {
      const registration = byProvider.get(provider);
      if (!registration) {
        throw new Error(`Communications provider "${provider}" is not configured for this practice.`);
      }
      switch (registration.provider) {
        case "google-workspace": {
          let adapter = adapters.get(registration.provider);
          if (!adapter) {
            adapter = createGoogleWorkspaceAdapter(registration.config, {
              fetchImpl: deps.fetchImpl,
              now: deps.now,
              warn: deps.warn,
            });
            adapters.set(registration.provider, adapter);
          }
          return createSuppressedCommsProvider(adapter, {
            fhir: callerFhir,
            practiceTimeZone: deps.practiceTimeZone ?? "UTC",
            now: deps.now,
          });
        }
        case "twilio": {
          const adapter = withTwilioConversationStore(getTwilioAdapter(registration), callerFhir);
          return createSuppressedCommsProvider(adapter, {
            fhir: callerFhir,
            practiceTimeZone: deps.practiceTimeZone ?? "UTC",
            now: deps.now,
          });
        }
        case "ghl": {
          const adapter = createGhlAdapter(registration.config, {
            fetchImpl: deps.fetchImpl,
            resolvePatientPhone: (patientReference) =>
              patientPhone(callerFhir, patientReference, deps.now?.() ?? new Date()),
          });
          return createSuppressedCommsProvider(adapter, {
            fhir: callerFhir,
            practiceTimeZone: deps.practiceTimeZone ?? "UTC",
            now: deps.now,
          });
        }
        default: {
          throw new Error(`Unhandled communications registration: ${JSON.stringify(registration)}`);
        }
      }
    },
  };
}

export function commsAdapterRegistrationsFromEnv(
  env: Record<string, string | undefined>,
): CommsAdapterRegistration[] {
  const providers = (env.ODOS_COMMS_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return providers.map((provider): CommsAdapterRegistration => {
    switch (provider) {
      case "google-workspace": {
        const required = [
          "GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL",
          "GOOGLE_WORKSPACE_PRIVATE_KEY",
          "GOOGLE_WORKSPACE_DELEGATED_USER",
          "GOOGLE_WORKSPACE_DOMAIN",
          "GOOGLE_WORKSPACE_FROM_ADDRESS",
        ] as const;
        const missing = required.find((name) => !env[name]?.trim());
        if (missing) {
          throw new Error(
            `Google Workspace communications adapter is partially configured — missing ${missing}.`,
          );
        }
        const confirmed = env.GOOGLE_WORKSPACE_PLAN_CONFIRMED?.trim().toLowerCase();
        if (confirmed && confirmed !== "true" && confirmed !== "false") {
          throw new Error("GOOGLE_WORKSPACE_PLAN_CONFIRMED must be true or false when set.");
        }
        return {
          provider,
          config: {
            serviceAccountEmail: env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL!.trim(),
            privateKey: env.GOOGLE_WORKSPACE_PRIVATE_KEY!,
            delegatedUserEmail: env.GOOGLE_WORKSPACE_DELEGATED_USER!.trim(),
            workspaceDomain: env.GOOGLE_WORKSPACE_DOMAIN!.trim(),
            fromAddress: env.GOOGLE_WORKSPACE_FROM_ADDRESS!.trim(),
            ...(confirmed ? { workspacePlanConfirmed: confirmed === "true" } : {}),
          },
        };
      }
      case "twilio": {
        const hipaaMode = optionalBoolean(env, "ODOS_HIPAA_MODE");
        const realTimeTranscriptionEnabled = optionalBoolean(
          env,
          "TWILIO_REAL_TIME_TRANSCRIPTION_ENABLED",
        );
        const mediaUrlAuthAcknowledged = optionalBoolean(
          env,
          "TWILIO_MEDIA_URL_AUTH_ACKNOWLEDGED",
        );
        const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
        const missing = required.find((name) => !env[name]?.trim());
        if (missing) {
          throw new Error(`Twilio communications adapter is partially configured — missing ${missing}.`);
        }
        if (!env.TWILIO_MESSAGING_SERVICE_SID?.trim() && !env.TWILIO_FROM_NUMBER?.trim()) {
          throw new Error(
            "Twilio communications adapter requires TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.",
          );
        }
        const voiceRequired = [
          "TWILIO_VOICE_FROM_NUMBER",
          "TWILIO_VOICE_FORWARD_TO_NUMBER",
          "TWILIO_VOICE_API_KEY_SID",
          "TWILIO_VOICE_API_KEY_SECRET",
        ] as const;
        const voiceConfigured = voiceRequired.filter((name) => env[name]?.trim());
        const voiceMissing = [...voiceRequired, "TWILIO_WEBHOOK_BASE_URL" as const]
          .find((name) => !env[name]?.trim());
        if (voiceConfigured.length > 0 && voiceMissing) {
          throw new Error(`Twilio Voice configuration is partial — missing ${voiceMissing}.`);
        }
        return {
          provider,
          config: {
            accountSid: env.TWILIO_ACCOUNT_SID!.trim(),
            authToken: env.TWILIO_AUTH_TOKEN!.trim(),
            hipaaMode,
            realTimeTranscriptionEnabled,
            mediaUrlAuthAcknowledged,
            ...(env.TWILIO_API_KEY_SID?.trim()
              ? { apiKeySid: env.TWILIO_API_KEY_SID.trim() }
              : {}),
            ...(env.TWILIO_API_KEY_SECRET?.trim()
              ? { apiKeySecret: env.TWILIO_API_KEY_SECRET.trim() }
              : {}),
            ...(env.TWILIO_MESSAGING_SERVICE_SID?.trim()
              ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID.trim() }
              : {}),
            ...(env.TWILIO_FROM_NUMBER?.trim()
              ? { fromNumber: env.TWILIO_FROM_NUMBER.trim() }
              : {}),
            ...(env.TWILIO_VOICE_FROM_NUMBER?.trim()
              ? { voiceFromNumber: env.TWILIO_VOICE_FROM_NUMBER.trim() }
              : {}),
            ...(env.TWILIO_VOICE_FORWARD_TO_NUMBER?.trim()
              ? { voiceForwardToNumber: env.TWILIO_VOICE_FORWARD_TO_NUMBER.trim() }
              : {}),
            ...(env.TWILIO_WEBHOOK_BASE_URL?.trim()
              ? { webhookBaseUrl: env.TWILIO_WEBHOOK_BASE_URL.trim() }
              : {}),
            ...(env.TWILIO_VOICE_API_KEY_SID?.trim()
              ? { voiceApiKeySid: env.TWILIO_VOICE_API_KEY_SID.trim() }
              : {}),
            ...(env.TWILIO_VOICE_API_KEY_SECRET?.trim()
              ? { voiceApiKeySecret: env.TWILIO_VOICE_API_KEY_SECRET.trim() }
              : {}),
          },
        };
      }
      case "ghl": {
        const required = ["GHL_LOCATION_ID", "GHL_ACCESS_TOKEN"] as const;
        const missing = required.find((name) => !env[name]?.trim());
        if (missing) {
          throw new Error(`GHL communications adapter is partially configured — missing ${missing}.`);
        }
        return {
          provider,
          config: {
            locationId: env.GHL_LOCATION_ID!.trim(),
            accessToken: env.GHL_ACCESS_TOKEN!.trim(),
          },
        };
      }
      default:
        throw new Error(`Unsupported communications provider "${provider}".`);
    }
  });
}

async function patientPhone(
  fhir: SuppressionFhir,
  patientReference: string,
  now: Date,
): Promise<string> {
  const match = /^Patient\/([A-Za-z0-9.-]{1,64})$/.exec(patientReference);
  if (!match) throw new Error("GHL conversation patientReference must be Patient/….");
  const patient = await fhir.read<Patient>("Patient", match[1]);
  const active = patient.telecom?.filter((point) =>
    (point.system === "sms" || point.system === "phone")
    && point.use !== "old"
    && Boolean(point.value?.trim())
    && (!point.period?.start || Date.parse(point.period.start) <= now.getTime())
    && (!point.period?.end || Date.parse(point.period.end) > now.getTime()));
  const phone = (
    active?.find((point) => point.system === "sms")
    ?? active?.find((point) => point.use === "mobile")
    ?? active?.[0]
  )?.value?.trim();
  if (!phone) throw new Error(`Patient/${patient.id ?? match[1]} has no active phone in Patient.telecom.`);
  return phone;
}

function optionalBoolean(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return false;
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false when set.`);
  }
  return value === "true";
}
