import type { MedplumClient } from "../fhir-client.js";
import {
  createGoogleWorkspaceAdapter,
  type GoogleWorkspaceAdapterConfig,
} from "./adapters/google-workspace-adapter.js";
import {
  createTwilioAdapter,
  type TwilioAdapterConfig,
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
    };

export interface CommsDispatchDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  warn?: (message: string) => void;
  practiceTimeZone?: string;
}

export type CommsDispatchFhir = Pick<MedplumClient, "read" | "search">;

export interface CommsDispatch {
  getAdapter(provider: string, fhir: CommsDispatchFhir): CommsProvider;
  providers(): string[];
}

export function createCommsDispatch(
  registrations: CommsAdapterRegistration[],
  deps: CommsDispatchDeps = {},
): CommsDispatch {
  const byProvider = new Map<string, CommsAdapterRegistration>(
    registrations.map((registration) => [registration.provider, registration]),
  );
  const adapters = new Map<string, CommsProvider>();
  return {
    providers() {
      return [...byProvider.keys()];
    },
    getAdapter(provider: string, fhir: SuppressionFhir): CommsProvider {
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
            fhir,
            practiceTimeZone: deps.practiceTimeZone ?? "UTC",
            now: deps.now,
          });
        }
        case "twilio": {
          let adapter = adapters.get(registration.provider);
          if (!adapter) {
            adapter = createTwilioAdapter(registration.config, {
              fetchImpl: deps.fetchImpl,
            });
            adapters.set(registration.provider, adapter);
          }
          return createSuppressedCommsProvider(adapter, {
            fhir,
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
      default:
        throw new Error(`Unsupported communications provider "${provider}".`);
    }
  });
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
