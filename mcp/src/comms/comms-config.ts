import type { MedplumClient } from "../fhir-client.js";
import {
  createGoogleWorkspaceAdapter,
  type GoogleWorkspaceAdapterConfig,
} from "./adapters/google-workspace-adapter.js";
import type { CommsProvider } from "./comms-provider.js";
import {
  createSuppressedCommsProvider,
  type SuppressionFhir,
} from "./suppression-gate.js";

export type CommsAdapterRegistration = {
  provider: "google-workspace";
  config: GoogleWorkspaceAdapterConfig;
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
    if (provider !== "google-workspace") {
      throw new Error(`Unsupported communications provider "${provider}".`);
    }
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
  });
}
