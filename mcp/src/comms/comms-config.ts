import type { Patient } from "@medplum/fhirtypes";
import {
  createAwsSmsAdapter,
  normalizeAwsSmsConfig,
  type AwsSmsAdapterConfig,
  type AwsSmsClient,
} from "./adapters/aws-sms-adapter.js";
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
  type SmsStopScope,
  type SuppressionFhir,
} from "./suppression-gate.js";

export const COMMS_CHANNEL_ROLES = [
  "voice",
  "transactional-sms",
  "marketing-sms",
  "clinical-sms",
  "email",
] as const;

export type CommsChannelRole = typeof COMMS_CHANNEL_ROLES[number];

export interface CommsChannelRoutingConfig {
  explicit: boolean;
  assignments: Partial<Record<CommsChannelRole, string>>;
  senderNumbers: Partial<Record<CommsChannelRole, string>>;
  stopScope: SmsStopScope;
  issues: string[];
}

export type CommsAdapterRegistration =
  | {
      provider: "aws";
      config: AwsSmsAdapterConfig;
    }
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
  channelRouting?: CommsChannelRoutingConfig;
  error?: (message: string) => void;
  fetchImpl?: typeof fetch;
  info?: (message: string) => void;
  now?: () => Date;
  warn?: (message: string) => void;
  practiceTimeZone?: string;
  twilioClientFactory?: TwilioClientFactory;
  awsSmsClient?: AwsSmsClient;
}

export type CommsDispatchFhir = SuppressionFhir;

export interface CommsDispatch {
  initialize(): Promise<void>;
  getAdapter(provider: string, callerFhir: CommsDispatchFhir): CommsProvider;
  getAdapterForRole(role: CommsChannelRole, callerFhir: CommsDispatchFhir): CommsProvider;
  providerFor(role: CommsChannelRole): string | undefined;
  senderNumberFor(role: CommsChannelRole): string | undefined;
  providers(): string[];
}

export function commsPublicBaseUrlFromEnv(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.warn,
): string {
  const configured = env.ODOS_COMMS_PUBLIC_BASE_URL?.trim();
  if (configured) return configured;
  const legacy = env.ODOS_PRACTICE_PUBLIC_BASE_URL?.trim();
  if (!legacy) return "";
  warn(
    "odos-mcp: ODOS_COMMS_PUBLIC_BASE_URL is unset; using legacy ODOS_PRACTICE_PUBLIC_BASE_URL for tracked education links.",
  );
  return legacy;
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
    const key = [
      registration.provider,
      registration.config.messagingServiceSid ?? "",
      registration.config.fromNumber ?? "",
    ].join("|");
    let adapter = adapters.get(key);
    if (!adapter) {
      adapter = createTwilioAdapter(registration.config, {
        fetchImpl: deps.fetchImpl,
        clientFactory: deps.twilioClientFactory,
        now: deps.now,
      });
      adapters.set(key, adapter);
    }
    return adapter as ReturnType<typeof createTwilioAdapter>;
  };
  const capabilityCache = new Map<string, CommsProvider["capabilities"] | undefined>();
  const capabilityFailures = new Map<string, string>();
  const capabilitiesFor = (
    registration: CommsAdapterRegistration,
  ): CommsProvider["capabilities"] | undefined => {
    if (capabilityCache.has(registration.provider)) {
      return capabilityCache.get(registration.provider);
    }
    try {
      let capabilities: CommsProvider["capabilities"];
      switch (registration.provider) {
        case "aws":
          capabilities = createAwsSmsAdapter(registration.config, {
            client: deps.awsSmsClient,
          }).capabilities;
          break;
        case "google-workspace":
          capabilities = createGoogleWorkspaceAdapter(registration.config, {
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            warn: deps.warn,
          }).capabilities;
          break;
        case "twilio":
          capabilities = getTwilioAdapter(registration).capabilities;
          break;
        case "ghl":
          capabilities = createGhlAdapter(registration.config, { fetchImpl: deps.fetchImpl }).capabilities;
          break;
      }
      capabilityCache.set(registration.provider, capabilities);
      return capabilities;
    } catch (error) {
      capabilityCache.set(registration.provider, undefined);
      capabilityFailures.set(
        registration.provider,
        error instanceof Error ? error.message : "unknown provider validation failure",
      );
      return undefined;
    }
  };
  const routing = deps.channelRouting ?? commsChannelRoutingFromEnv({});
  const routingErrors = [...routing.issues];
  const requestedAssignments = routing.explicit
    ? routing.assignments
    : implicitChannelAssignments(byProvider, capabilitiesFor);
  if (!routing.explicit) {
    for (const [provider, reason] of capabilityFailures) {
      routingErrors.push(
        `provider "${provider}" could not be validated for implicit channel routing: ${reason}`,
      );
    }
  }
  const resolvedAssignments: Partial<Record<CommsChannelRole, string>> = {};
  for (const role of COMMS_CHANNEL_ROLES) {
    const provider = requestedAssignments[role];
    if (!provider) continue;
    const registration = byProvider.get(provider);
    if (!registration) {
      routingErrors.push(
        `channel role "${role}" names provider "${provider}", which is not selected by the scalar communications provider configuration`,
      );
      continue;
    }
    const capability = capabilityForRole(role);
    const capabilities = capabilitiesFor(registration);
    if (!capabilities) {
      routingErrors.push(
        `channel role "${role}" names provider "${provider}", whose capability validation failed: ${capabilityFailures.get(provider) ?? "unknown provider validation failure"}`,
      );
      continue;
    }
    if (!capabilities[capability]) {
      routingErrors.push(
        `channel role "${role}" names provider "${provider}", which does not report the required ${capability} capability`,
      );
      continue;
    }
    resolvedAssignments[role] = provider;
  }
  const senderNumberFor = (role: CommsChannelRole): string | undefined =>
    resolvedAssignments[role] ? routing.senderNumbers[role] : undefined;
  const senderNumberForProvider = (provider: string): string | undefined => {
    const numbers = new Set(COMMS_CHANNEL_ROLES.flatMap((role) =>
      resolvedAssignments[role] === provider && routing.senderNumbers[role]
        ? [routing.senderNumbers[role]!]
        : []));
    return numbers.size === 1 ? numbers.values().next().value : undefined;
  };
  const adapterFor = (
    provider: string,
    callerFhir: SuppressionFhir,
    role?: CommsChannelRole,
  ): CommsProvider => {
    const configured = byProvider.get(provider);
    if (!configured) {
      throw new Error(`Communications provider "${provider}" is not configured for this practice.`);
    }
    const smsSenderNumber = role ? senderNumberFor(role) : senderNumberForProvider(provider);
    const registration = withSmsSenderNumber(configured, smsSenderNumber);
    const suppression = {
      fhir: callerFhir,
      practiceTimeZone: deps.practiceTimeZone ?? "UTC",
      smsSenderNumber,
      stopScope: routing.stopScope,
      now: deps.now,
    };
    switch (registration.provider) {
      case "aws": {
        const adapter = createAwsSmsAdapter(registration.config, {
          client: deps.awsSmsClient,
        });
        return scopeAdapter(
          createSuppressedCommsProvider(adapter, suppression),
          registration.provider,
          resolvedAssignments,
          routing.explicit,
        );
      }
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
        return scopeAdapter(
          createSuppressedCommsProvider(adapter, suppression),
          registration.provider,
          resolvedAssignments,
          routing.explicit,
        );
      }
      case "twilio": {
        const adapter = withTwilioConversationStore(getTwilioAdapter(registration), callerFhir);
        const suppressed = createSuppressedCommsProvider(adapter, suppression);
        return scopeAdapter({
          ...suppressed,
          async sendSms(request) {
            await adapter.initialize();
            return suppressed.sendSms!(request);
          },
        }, registration.provider, resolvedAssignments, routing.explicit);
      }
      case "ghl": {
        const adapter = createGhlAdapter(registration.config, {
          fetchImpl: deps.fetchImpl,
          resolvePatientPhone: (patientReference) =>
            patientPhone(callerFhir, patientReference, deps.now?.() ?? new Date()),
        });
        return scopeAdapter(
          createSuppressedCommsProvider(adapter, suppression),
          registration.provider,
          resolvedAssignments,
          routing.explicit,
        );
      }
    }
  };
  return {
    async initialize() {
      for (const reason of routingErrors) {
        (deps.error ?? console.error)(
          `odos-mcp: communications routing DEGRADED; ${reason}. The affected role is unavailable while ODOS continues starting.`,
        );
      }
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
    providerFor(role) {
      return resolvedAssignments[role];
    },
    senderNumberFor,
    getAdapterForRole(role, callerFhir) {
      const provider = resolvedAssignments[role];
      if (!provider) {
        throw new Error(`Communications role "${role}" is not configured for this practice.`);
      }
      return adapterFor(provider, callerFhir, role);
    },
    getAdapter(provider: string, callerFhir: SuppressionFhir): CommsProvider {
      return adapterFor(provider, callerFhir);
    },
  };
}

export function commsChannelRoutingFromEnv(
  env: Record<string, string | undefined>,
): CommsChannelRoutingConfig {
  const config = commsProviderConfigFromEnv(env);
  const assignments: Partial<Record<CommsChannelRole, string>> = {};
  const senderNumbers: Partial<Record<CommsChannelRole, string>> = {};
  const issues: string[] = [];
  const transactionalNumber = scalarE164(env, "ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER");
  const clinicalProvider = config.clinical_sms_provider
    ?? (config.sms_provider === "ghl" ? undefined : config.sms_provider);
  const clinicalNumber = scalarE164(env, "ODOS_COMMS_CLINICAL_SMS_NUMBER")
    ?? (clinicalProvider === config.sms_provider ? transactionalNumber : undefined);
  const messagingServiceConfigured = Boolean(env.TWILIO_MESSAGING_SERVICE_SID?.trim());
  const assignSmsRole = (
    role: "transactional-sms" | "marketing-sms" | "clinical-sms",
    provider: "aws" | "twilio" | "ghl",
    number: string | undefined,
    numberVariable: "ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER" | "ODOS_COMMS_CLINICAL_SMS_NUMBER",
  ): void => {
    if (provider === "twilio" && number && messagingServiceConfigured) {
      issues.push(
        `channel role "${role}" cannot combine TWILIO_MESSAGING_SERVICE_SID with ${numberVariable}; choose the Messaging Service or the lane sender number`,
      );
      return;
    }
    assignments[role] = provider;
    if (number) senderNumbers[role] = number;
  };
  if (config.sms_provider) {
    assignSmsRole("transactional-sms", config.sms_provider, transactionalNumber, "ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER");
    assignSmsRole("marketing-sms", config.sms_provider, transactionalNumber, "ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER");
  }
  if (config.clinical_sms_provider === "ghl") {
    issues.push(
      'channel role "clinical-sms" refuses provider "ghl" because this practice has no BAA for diagnosis-specific messaging',
    );
  } else if (clinicalProvider) {
    assignSmsRole(
      "clinical-sms",
      clinicalProvider,
      clinicalNumber,
      env.ODOS_COMMS_CLINICAL_SMS_NUMBER?.trim()
        ? "ODOS_COMMS_CLINICAL_SMS_NUMBER"
        : "ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER",
    );
  }
  if (config.voice_provider && config.voice_provider !== "none") {
    assignments.voice = config.voice_provider;
  }
  if (config.email_provider && config.email_provider !== "none") {
    assignments.email = config.email_provider;
  }
  return {
    explicit: Boolean(
      config.sms_provider
      || config.clinical_sms_provider
      || config.voice_provider
      || config.email_provider
    ),
    assignments,
    senderNumbers,
    stopScope: scalarProvider(env, "ODOS_COMMS_STOP_SCOPE", ["per-number", "global"]) ?? "per-number",
    issues,
  };
}

export interface CommsProviderConfig {
  sms_provider?: "aws" | "twilio" | "ghl";
  clinical_sms_provider?: "aws" | "twilio" | "ghl";
  voice_provider?: "twilio" | "ghl" | "none";
  email_provider?: "google-workspace" | "none";
}

const BREAKING_COMMS_CONFIG_MIGRATION =
  "Breaking configuration migration: ODOS_COMMS_PROVIDERS and ODOS_COMMS_CHANNEL_ROUTES were replaced by scalar ODOS_COMMS_SMS_PROVIDER, ODOS_COMMS_VOICE_PROVIDER, and ODOS_COMMS_EMAIL_PROVIDER.";

export function commsProviderConfigFromEnv(
  env: Record<string, string | undefined>,
): CommsProviderConfig {
  if (env.ODOS_COMMS_PROVIDERS?.trim() || env.ODOS_COMMS_CHANNEL_ROUTES?.trim()) {
    throw new Error(BREAKING_COMMS_CONFIG_MIGRATION);
  }
  const clinicalSmsProvider = scalarProvider(
    env,
    "ODOS_COMMS_CLINICAL_SMS_PROVIDER",
    ["aws", "twilio", "ghl"],
  );
  return {
    sms_provider: scalarProvider(env, "ODOS_COMMS_SMS_PROVIDER", ["aws", "twilio", "ghl"]),
    ...(clinicalSmsProvider ? { clinical_sms_provider: clinicalSmsProvider } : {}),
    voice_provider: scalarProvider(env, "ODOS_COMMS_VOICE_PROVIDER", ["twilio", "ghl", "none"]),
    email_provider: scalarProvider(env, "ODOS_COMMS_EMAIL_PROVIDER", ["google-workspace", "none"]),
  };
}

function implicitChannelAssignments(
  registrations: Map<string, CommsAdapterRegistration>,
  capabilitiesFor: (
    registration: CommsAdapterRegistration,
  ) => CommsProvider["capabilities"] | undefined,
): Partial<Record<CommsChannelRole, string>> {
  const registration = registrations.get("twilio")
    ?? (registrations.size === 1 ? registrations.values().next().value : undefined);
  if (!registration) return {};
  const capabilities = capabilitiesFor(registration);
  if (!capabilities) return {};
  return Object.fromEntries(COMMS_CHANNEL_ROLES.flatMap((role) =>
    capabilities[capabilityForRole(role)] ? [[role, registration.provider]] : []));
}

function capabilityForRole(role: CommsChannelRole): "calls" | "sms" | "email" {
  switch (role) {
    case "voice": return "calls";
    case "transactional-sms":
    case "marketing-sms":
    case "clinical-sms": return "sms";
    case "email": return "email";
  }
}

export function commsAdapterRegistrationsFromEnv(
  env: Record<string, string | undefined>,
): CommsAdapterRegistration[] {
  const config = commsProviderConfigFromEnv(env);
  const providers = [
    config.sms_provider,
    config.clinical_sms_provider === "ghl" ? undefined : config.clinical_sms_provider,
    config.voice_provider,
    config.email_provider,
  ]
    .filter((provider): provider is Exclude<typeof provider, "none" | undefined> =>
      provider !== undefined && provider !== "none")
    .filter((provider, index, all) => all.indexOf(provider) === index);
  return providers.map((provider): CommsAdapterRegistration => {
    switch (provider) {
      case "aws": {
        const required = [
          "AWS_SMS_REGION",
          "AWS_SMS_ORIGINATION_IDENTITY",
          "AWS_SMS_SQS_QUEUE_URL",
          "AWS_SMS_SNS_TOPIC_ARN",
        ] as const;
        const missing = required.find((name) => !env[name]?.trim());
        if (missing) {
          throw new Error(`AWS SMS communications adapter is partially configured — missing ${missing}.`);
        }
        return {
          provider,
          config: normalizeAwsSmsConfig({
            region: env.AWS_SMS_REGION!,
            originationIdentity: env.AWS_SMS_ORIGINATION_IDENTITY!,
            inboundQueueUrl: env.AWS_SMS_SQS_QUEUE_URL!,
            inboundTopicArn: env.AWS_SMS_SNS_TOPIC_ARN!,
          }),
        };
      }
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

function scopeAdapter(
  adapter: CommsProvider,
  provider: string,
  assignments: Partial<Record<CommsChannelRole, string>>,
  enforce: boolean,
): CommsProvider {
  if (!enforce) return adapter;
  const sms = assignments["transactional-sms"] === provider
    || assignments["marketing-sms"] === provider
    || assignments["clinical-sms"] === provider;
  const calls = assignments.voice === provider;
  const email = assignments.email === provider;
  const {
    sendSms,
    initiateCall,
    getCall,
    listCalls,
    fetchRecording,
    fetchTranscription,
    sendEmail,
    ...rest
  } = adapter;
  return {
    ...rest,
    capabilities: {
      ...adapter.capabilities,
      sms: adapter.capabilities.sms && sms,
      calls: adapter.capabilities.calls && calls,
      email: adapter.capabilities.email && email,
    },
    ...(sms && sendSms ? { sendSms } : {}),
    ...(calls && initiateCall ? { initiateCall } : {}),
    ...(calls && getCall ? { getCall } : {}),
    ...(calls && listCalls ? { listCalls } : {}),
    ...(calls && fetchRecording ? { fetchRecording } : {}),
    ...(calls && fetchTranscription ? { fetchTranscription } : {}),
    ...(email && sendEmail ? { sendEmail } : {}),
  };
}

function scalarProvider<const T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!allowed.includes(value as T)) {
    const choices = allowed.join(", ");
    throw new Error(`${name} must be exactly one of ${choices.replace(/, ([^,]+)$/, ", or $1")}.`);
  }
  return value as T;
}

function scalarE164(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`${name} must use E.164 format.`);
  }
  return value;
}

function withSmsSenderNumber(
  registration: CommsAdapterRegistration,
  senderNumber: string | undefined,
): CommsAdapterRegistration {
  if (!senderNumber) return registration;
  switch (registration.provider) {
    case "twilio":
      if (registration.config.messagingServiceSid) return registration;
      return {
        ...registration,
        config: {
          ...registration.config,
          fromNumber: senderNumber,
        },
      };
    default:
      return registration;
  }
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
