import type { Basic } from "@medplum/fhirtypes";

export const ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/statement-message-config";
export const ODOS_STATEMENT_MESSAGE_CONFIG_CODE = "odos-statement-message-config";
export const ODOS_STATEMENT_MESSAGE_CONFIG_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-statement-message-config";
export const ODOS_STATEMENT_MESSAGE_CONFIG_RESOURCE_ID = "statement-message-config";
export const STATEMENT_MESSAGE_MAX_LENGTH = 320;

export interface PersistedStatementMessageConfig {
  statementFooterMessage?: string;
  receiptFooterMessage?: string;
}

export function validateStatementMessageConfig(config: PersistedStatementMessageConfig): void {
  validateMessage("Statement footer message", config.statementFooterMessage);
  validateMessage("Receipt footer message", config.receiptFooterMessage);
}

export function buildStatementMessageConfigResource(
  config: PersistedStatementMessageConfig,
  existing?: Basic,
): Basic {
  validateStatementMessageConfig(config);
  const persisted: PersistedStatementMessageConfig = {
    ...(config.statementFooterMessage ? { statementFooterMessage: config.statementFooterMessage } : {}),
    ...(config.receiptFooterMessage ? { receiptFooterMessage: config.receiptFooterMessage } : {}),
  };
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    code: {
      coding: [
        {
          system: ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM,
          code: ODOS_STATEMENT_MESSAGE_CONFIG_CODE,
          display: "ODOS Statement and Receipt Message Config",
        },
      ],
      text: "ODOS Statement and Receipt Message Config",
    },
    extension: [
      {
        url: ODOS_STATEMENT_MESSAGE_CONFIG_EXTENSION_URL,
        valueString: JSON.stringify(persisted),
      },
    ],
  };
}

export function parseStatementMessageConfig(basic: Basic): PersistedStatementMessageConfig {
  const coding = basic.code?.coding?.find(
    (candidate) =>
      candidate.system === ODOS_STATEMENT_MESSAGE_CONFIG_SYSTEM
      && candidate.code === ODOS_STATEMENT_MESSAGE_CONFIG_CODE,
  );
  if (!coding) {
    throw new Error("Basic resource is not the odos statement-message-config singleton.");
  }
  const raw = basic.extension?.find(
    (extension) => extension.url === ODOS_STATEMENT_MESSAGE_CONFIG_EXTENSION_URL,
  )?.valueString;
  if (!raw) {
    throw new Error("Statement-message-config singleton is missing its config extension.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Statement-message-config JSON is malformed and cannot be parsed.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Statement-message-config JSON is malformed and cannot be parsed.");
  }
  const values = parsed as Record<string, unknown>;
  const config: PersistedStatementMessageConfig = {
    ...(values.statementFooterMessage !== undefined
      ? { statementFooterMessage: values.statementFooterMessage as string }
      : {}),
    ...(values.receiptFooterMessage !== undefined
      ? { receiptFooterMessage: values.receiptFooterMessage as string }
      : {}),
  };
  validateStatementMessageConfig(config);
  return config;
}

function validateMessage(label: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`${label} must be text.`);
  }
  if (value.length > STATEMENT_MESSAGE_MAX_LENGTH) {
    throw new Error(`${label} must be ${STATEMENT_MESSAGE_MAX_LENGTH} characters or fewer.`);
  }
}
