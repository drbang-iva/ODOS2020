import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createLiveOperatorIdentityAdapter } from "../data/medplum-adapters/operator-bootstrap-adapter.js";
import {
  findOperatorMembershipFromPostgres,
  verifyOperatorMembershipFromPostgres,
} from "../mcp/src/authz/operatorMembershipVerification.js";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { loginForLocalRepair } from "./repair-practice-roles.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

export const OPERATOR_CLIENT_NAME = "ODOS Local Operator";
const OPERATOR_CLIENT_RESOURCE_TYPE = ["Client", "Application"].join("");
export const DEFAULT_OPERATOR_CREDENTIAL_PATH = resolve(process.cwd(), ".odos/operator.env");
export const DEFAULT_OPERATOR_PREVIOUS_CREDENTIAL_PATH = resolve(process.cwd(), ".odos/operator-previous.env");
export const DEFAULT_OPERATOR_STATE_PATH = resolve(process.cwd(), ".odos/operator-identity.json");
const DEFAULT_OPERATOR_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";

export interface OperatorCredentials {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type OperatorReplacementReason =
  | "initial-setup"
  | "rotation"
  | "project-rebuild"
  | "post-revocation";

export interface OperatorIdentityState {
  readonly version: 1;
  readonly status: "active" | "revoked" | "cleanup-pending";
  readonly projectId: string;
  readonly clientId: string;
  readonly membershipId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replacementReason: OperatorReplacementReason;
  readonly previousClientId?: string;
  readonly pendingRevocation?: { readonly clientId: string; readonly membershipId?: string };
  readonly pendingCleanup?: {
    readonly projectId: string;
    readonly clientId: string;
    readonly membershipId?: string;
  };
  readonly pendingEmergencyRevocation?: { readonly clientId: string; readonly membershipId?: string };
  readonly revokedAt?: string;
  readonly revocationReason?: "credential-exposure";
}

export interface VerifiedOperatorSession {
  readonly accessToken: string;
  readonly membershipId: string;
}

export interface OperatorIdentityAdapter {
  create(projectId: string): Promise<{ clientId: string; clientSecret: string }>;
  resolveMembership(projectId: string, clientId: string): Promise<string>;
  clientExists(projectId: string, clientId: string): Promise<boolean>;
  verify(credentials: OperatorCredentials): Promise<VerifiedOperatorSession>;
  revoke(
    projectId: string,
    clientId: string,
    membershipId: string | undefined,
    credentials?: OperatorCredentials,
  ): Promise<void>;
}

export interface OperatorIdentityStore {
  readCredentials(): OperatorCredentials | undefined;
  writeCredentials(credentials: OperatorCredentials): void;
  removeCredentials(): void;
  readPreviousCredentials(): OperatorCredentials | undefined;
  writePreviousCredentials(credentials: OperatorCredentials): void;
  removePreviousCredentials(): void;
  readState(): OperatorIdentityState | undefined;
  writeState(state: OperatorIdentityState): void;
  removeState(): void;
}

export async function ensureLiveOperatorIdentity(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly serviceEmail: string;
  readonly servicePassword: string;
  readonly postgresUrl?: string;
  readonly credentialPath?: string;
  readonly statePath?: string;
}): Promise<{ accessToken: string; state: OperatorIdentityState; reused: boolean }> {
  const baseUrl = localBaseUrl(input.baseUrl);
  const serviceAccessToken = await loginForLocalRepair({
    baseUrl,
    email: requiredValue(input.serviceEmail, "MEDPLUM_ADMIN_EMAIL"),
    password: requiredValue(input.servicePassword, "MEDPLUM_ADMIN_PASSWORD"),
  });
  return ensureOperatorIdentity({
    projectId: input.projectId,
    adapter: createLiveOperatorIdentityAdapter({
      baseUrl,
      serviceAccessToken,
      clientName: OPERATOR_CLIENT_NAME,
      verifyMembership: membershipVerifier(input.postgresUrl),
      resolveMembership: membershipResolver(input.postgresUrl),
    }),
    store: createFileOperatorIdentityStore(input),
  });
}

export async function loadVerifiedOperatorFhirClient(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly postgresUrl?: string;
  readonly credentialPath?: string;
  readonly statePath?: string;
}): Promise<{ fhir: MedplumClient; accessToken: string; state: OperatorIdentityState }> {
  const baseUrl = localBaseUrl(input.baseUrl);
  const verified = await verifyStoredOperatorIdentity({
    projectId: input.projectId,
    adapter: createLiveOperatorIdentityAdapter({
      baseUrl,
      clientName: OPERATOR_CLIENT_NAME,
      verifyMembership: membershipVerifier(input.postgresUrl),
      resolveMembership: membershipResolver(input.postgresUrl),
    }),
    store: createFileOperatorIdentityStore(input),
  });
  return {
    ...verified,
    fhir: createOperatorScriptFhirClient({
      baseUrl,
      accessToken: verified.accessToken,
      reason: "Operator identity runs local setup, repair, reseed, and integrity work outside request handling.",
    }),
  };
}

export async function runOperatorIdentityCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  action: "ensure" | "rotate" | "revoke" | "replace-revoked" | "finish-pending-cleanup";
  state?: OperatorIdentityState;
}> {
  const actionFlags = ["--rotate", "--revoke", "--replace-revoked", "--finish-pending-cleanup"]
    .filter((flag) => args.includes(flag));
  if (actionFlags.length > 1) {
    throw new Error("Choose only one operator identity lifecycle action.");
  }
  const action = actionFlags[0] === "--rotate"
    ? "rotate"
    : actionFlags[0] === "--revoke"
      ? "revoke"
      : actionFlags[0] === "--replace-revoked"
        ? "replace-revoked"
        : actionFlags[0] === "--finish-pending-cleanup"
          ? "finish-pending-cleanup"
        : "ensure";
  const baseUrl = localBaseUrl(env.MEDPLUM_BASE_URL ?? "http://localhost:8103");
  const projectId = resolveCliProjectId(args, env);
  const serviceAccessToken = await loginForLocalRepair({
    baseUrl,
    email: requiredValue(env.MEDPLUM_ADMIN_EMAIL, "MEDPLUM_ADMIN_EMAIL"),
    password: requiredValue(env.MEDPLUM_ADMIN_PASSWORD, "MEDPLUM_ADMIN_PASSWORD"),
  });
  const adapter = createLiveOperatorIdentityAdapter({
    baseUrl,
    serviceAccessToken,
    clientName: OPERATOR_CLIENT_NAME,
    verifyMembership: membershipVerifier(env.ODOS_POSTGRES_URL),
    resolveMembership: membershipResolver(env.ODOS_POSTGRES_URL),
  });
  const store = createFileOperatorIdentityStore();
  if (action === "rotate") {
    const result = await rotateOperatorIdentity({ projectId, adapter, store });
    return { action, state: result.state };
  }
  if (action === "revoke") {
    const result = await revokeOperatorIdentity({
      projectId,
      adapter,
      store,
      reason: "credential-exposure",
    });
    return { action, state: result.state };
  }
  if (action === "replace-revoked") {
    const result = await replaceRevokedOperatorIdentity({ projectId, adapter, store });
    return { action, state: result.state };
  }
  if (action === "finish-pending-cleanup") {
    const result = await finishOperatorPendingCleanup({ projectId, adapter, store });
    return { action, state: result.state };
  }
  const result = await ensureOperatorIdentity({ projectId, adapter, store });
  return { action, state: result.state };
}

export async function ensureOperatorIdentity(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
}): Promise<{ accessToken: string; state: OperatorIdentityState; reused: boolean }> {
  const projectId = requiredProjectId(input.projectId);
  let state = input.store.readState();
  state = (await recoverUnrecordedPreviousCredential(input, projectId, state)).state;
  let credentials = input.store.readCredentials();

  if (state?.pendingCleanup) {
    await finishPendingCleanup(input, state);
    state = input.store.readState();
    credentials = input.store.readCredentials();
  }

  if (!state && !credentials) {
    const created = await createAndPersist(input, projectId, "initial-setup");
    return { ...created, reused: false };
  }
  if (!state) {
    throw new Error("Operator credential file exists without lifecycle state; refusing to infer its authority.");
  }
  if (state.status === "revoked" && state.projectId === projectId) {
    throw new Error("Operator identity is revoked; explicit replacement is required before setup can continue.");
  }
  if (state.projectId !== projectId) {
    input.store.removePreviousCredentials();
    const created = await createAndPersist(input, projectId, "project-rebuild", state.clientId, state);
    return { ...created, reused: false };
  }
  if (state.pendingRevocation) {
    const resumed = await finishPendingRotation(input, state);
    return { ...resumed, reused: true };
  }
  if (state.pendingEmergencyRevocation) {
    throw new Error("Operator emergency revocation cleanup is pending; rerun the revoke command.");
  }
  const matchingCredentials = matchingActiveCredentials(state, credentials);
  const verified = await input.adapter.verify(matchingCredentials);
  const now = timestamp(input.now);
  const verifiedState: OperatorIdentityState = {
    ...state,
    membershipId: verified.membershipId,
    updatedAt: now,
  };
  input.store.writeState(verifiedState);
  return { accessToken: verified.accessToken, state: verifiedState, reused: true };
}

export async function verifyStoredOperatorIdentity(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
}): Promise<{ accessToken: string; state: OperatorIdentityState }> {
  const projectId = requiredProjectId(input.projectId);
  const state = input.store.readState();
  if (!state || state.status !== "active" || state.projectId !== projectId) {
    throw new Error("No active operator identity exists for the exact project; run setup-practice first.");
  }
  if (state.pendingRevocation) {
    throw new Error("Operator rotation cleanup is pending; rerun npm run operator-identity -- --rotate first.");
  }
  if (state.pendingCleanup) {
    throw new Error("Operator failed-verification cleanup is pending; rerun operator setup with service credentials.");
  }
  if (state.pendingEmergencyRevocation) {
    throw new Error("Operator emergency revocation cleanup is pending; rerun the revoke command.");
  }
  const verified = await input.adapter.verify(matchingActiveCredentials(state, input.store.readCredentials()));
  const verifiedState: OperatorIdentityState = {
    ...state,
    membershipId: verified.membershipId,
    updatedAt: timestamp(input.now),
  };
  input.store.writeState(verifiedState);
  return { accessToken: verified.accessToken, state: verifiedState };
}

export async function rotateOperatorIdentity(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
}): Promise<{ accessToken: string; state: OperatorIdentityState }> {
  const projectId = requiredProjectId(input.projectId);
  let state = input.store.readState();
  state = (await recoverUnrecordedPreviousCredential(input, projectId, state)).state;
  if (state?.pendingCleanup) {
    await finishPendingCleanup(input, state);
    state = input.store.readState();
  }
  if (!state || state.status !== "active" || state.projectId !== projectId) {
    throw new Error("Rotation requires one active operator identity in the exact project.");
  }
  if (state.pendingRevocation) return finishPendingRotation(input, state);
  const credentials = matchingActiveCredentials(state, input.store.readCredentials());
  await input.adapter.verify(credentials);
  const created = await input.adapter.create(projectId);
  const replacementCredentials: OperatorCredentials = {
    projectId,
    clientId: created.clientId,
    clientSecret: created.clientSecret,
  };
  const replacementSession = await verifyCreatedIdentity(input, {
    credentials: replacementCredentials,
    replacementReason: "rotation",
    priorState: state,
  });
  const now = timestamp(input.now);
  const pendingState: OperatorIdentityState = {
    version: 1,
    status: "active",
    projectId,
    clientId: replacementCredentials.clientId,
    membershipId: replacementSession.membershipId,
    createdAt: now,
    updatedAt: now,
    replacementReason: "rotation",
    previousClientId: state.clientId,
    pendingRevocation: { clientId: state.clientId, ...(state.membershipId ? { membershipId: state.membershipId } : {}) },
  };
  input.store.writePreviousCredentials(credentials);
  input.store.writeCredentials(replacementCredentials);
  input.store.writeState(pendingState);
  await input.adapter.revoke(projectId, state.clientId, state.membershipId, credentials);
  const completedState = withoutPendingRevocation(pendingState, timestamp(input.now));
  input.store.writeState(completedState);
  input.store.removePreviousCredentials();
  return { accessToken: replacementSession.accessToken, state: completedState };
}

export async function revokeOperatorIdentity(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
  readonly reason: "credential-exposure";
}): Promise<{ state: OperatorIdentityState }> {
  const projectId = requiredProjectId(input.projectId);
  let state = input.store.readState();
  state = (await recoverUnrecordedPreviousCredential(input, projectId, state)).state;
  if (state?.pendingCleanup) {
    await finishPendingCleanup(input, state);
    state = input.store.readState();
  }
  if (state?.status === "revoked" && state.projectId === projectId) {
    input.store.removeCredentials();
    return { state };
  }
  if (!state || state.status !== "active" || state.projectId !== projectId) {
    throw new Error("Revocation requires one active operator identity in the exact project.");
  }
  if (state.pendingRevocation) {
    throw new Error("Operator revocation refuses while rotation cleanup is pending; finish rotation first.");
  }
  const pending = state.pendingEmergencyRevocation;
  if (!pending) {
    const credentials = matchingActiveCredentials(state, input.store.readCredentials());
    const verified = await input.adapter.verify(credentials);
    const membershipId = state.membershipId ?? verified.membershipId;
    state = {
      ...state,
      membershipId,
      updatedAt: timestamp(input.now),
      pendingEmergencyRevocation: {
        clientId: state.clientId,
        membershipId,
      },
    };
    input.store.writeState(state);
  }
  return finishPendingEmergencyRevocation(input, state, false);
}

export async function finishOperatorPendingCleanup(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
}): Promise<{ state?: OperatorIdentityState }> {
  const projectId = requiredProjectId(input.projectId);
  const recovery = await recoverUnrecordedPreviousCredential(input, projectId, input.store.readState());
  const state = recovery.state;
  if (recovery.completed) return { state };
  if (!state || state.projectId !== projectId) {
    throw new Error("No operator identity cleanup is recorded for the exact project.");
  }
  if (state.pendingCleanup) {
    await finishPendingCleanup(input, state, true);
    return { state: input.store.readState() };
  }
  if (state.pendingRevocation) {
    const result = await finishPendingRotation(input, state, true);
    return { state: result.state };
  }
  if (state.pendingEmergencyRevocation) {
    return finishPendingEmergencyRevocation(
      { ...input, reason: "credential-exposure" },
      state,
      true,
    );
  }
  throw new Error("Operator identity has no pending cleanup to finish.");
}

export async function replaceRevokedOperatorIdentity(input: {
  readonly projectId: string;
  readonly adapter: OperatorIdentityAdapter;
  readonly store: OperatorIdentityStore;
  readonly now?: () => string;
}): Promise<{ accessToken: string; state: OperatorIdentityState }> {
  const projectId = requiredProjectId(input.projectId);
  const state = (await recoverUnrecordedPreviousCredential(
    input,
    projectId,
    input.store.readState(),
  )).state;
  if (!state || state.status !== "revoked" || state.projectId !== projectId) {
    throw new Error("Post-revocation replacement requires a same-project revoked tombstone.");
  }
  if (input.store.readCredentials()) {
    throw new Error("Post-revocation replacement refuses while an active operator credential file remains.");
  }
  return createAndPersist(input, projectId, "post-revocation", state.clientId, state);
}

export function createFileOperatorIdentityStore(input: {
  readonly credentialPath?: string;
  readonly previousCredentialPath?: string;
  readonly statePath?: string;
} = {}): OperatorIdentityStore {
  const credentialPath = input.credentialPath ?? DEFAULT_OPERATOR_CREDENTIAL_PATH;
  const previousCredentialPath = input.previousCredentialPath ?? DEFAULT_OPERATOR_PREVIOUS_CREDENTIAL_PATH;
  const statePath = input.statePath ?? DEFAULT_OPERATOR_STATE_PATH;
  return {
    readCredentials: () => readCredentialFile(credentialPath),
    writeCredentials: (credentials) => writePrivateFile(
      credentialPath,
      [
        `ODOS_OPERATOR_PROJECT_ID=${credentials.projectId}`,
        `ODOS_OPERATOR_CLIENT_ID=${credentials.clientId}`,
        `ODOS_OPERATOR_CLIENT_SECRET=${credentials.clientSecret}`,
        "",
      ].join("\n"),
    ),
    removeCredentials: () => {
      if (existsSync(credentialPath)) unlinkSync(credentialPath);
    },
    readPreviousCredentials: () => readCredentialFile(previousCredentialPath),
    writePreviousCredentials: (credentials) => writePrivateFile(
      previousCredentialPath,
      [
        `ODOS_OPERATOR_PROJECT_ID=${credentials.projectId}`,
        `ODOS_OPERATOR_CLIENT_ID=${credentials.clientId}`,
        `ODOS_OPERATOR_CLIENT_SECRET=${credentials.clientSecret}`,
        "",
      ].join("\n"),
    ),
    removePreviousCredentials: () => {
      if (existsSync(previousCredentialPath)) unlinkSync(previousCredentialPath);
    },
    readState: () => readStateFile(statePath),
    writeState: (state) => writePrivateFile(statePath, `${JSON.stringify(state, null, 2)}\n`),
    removeState: () => {
      if (existsSync(statePath)) unlinkSync(statePath);
    },
  };
}

async function finishPendingRotation(
  input: {
    readonly projectId: string;
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  state: OperatorIdentityState,
  allowUncredentialedRevocation = false,
): Promise<{ accessToken: string; state: OperatorIdentityState }> {
  const pending = state.pendingRevocation;
  if (!pending) throw new Error("Operator rotation has no pending revocation to finish.");
  const current = matchingActiveCredentials(state, input.store.readCredentials());
  const currentSession = await input.adapter.verify(current);
  const previous = input.store.readPreviousCredentials();
  if (previous && (
    previous.projectId !== state.projectId ||
    previous.clientId !== pending.clientId
  )) {
    throw new Error("Pending operator rotation credential does not match its recorded client and project.");
  }
  if (
    !previous ||
    previous.projectId !== state.projectId ||
    previous.clientId !== pending.clientId
  ) {
    if (await input.adapter.clientExists(state.projectId, pending.clientId)) {
      const membershipId = pending.membershipId ?? await input.adapter.resolveMembership(
        state.projectId,
        pending.clientId,
      );
      if (!allowUncredentialedRevocation) {
        throw pendingCleanupRecoveryError(state.projectId, pending.clientId, membershipId);
      }
      await input.adapter.revoke(state.projectId, pending.clientId, membershipId);
    }
  } else {
    await input.adapter.revoke(state.projectId, pending.clientId, pending.membershipId, previous);
  }
  const completedState = withoutPendingRevocation(state, timestamp(input.now));
  input.store.writeState(completedState);
  input.store.removePreviousCredentials();
  return { accessToken: currentSession.accessToken, state: completedState };
}

async function finishPendingCleanup(
  input: {
    readonly projectId: string;
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  state: OperatorIdentityState,
  allowUncredentialedRevocation = false,
): Promise<void> {
  const pending = state.pendingCleanup;
  if (!pending) throw new Error("Operator identity has no failed-verification cleanup to finish.");
  if (!await input.adapter.clientExists(pending.projectId, pending.clientId)) {
    if (pending.membershipId) {
      await input.adapter.revoke(pending.projectId, pending.clientId, pending.membershipId);
    }
    finishCleanupState(input.store, state, timestamp(input.now));
    input.store.removePreviousCredentials();
    return;
  }
  const credentials = input.store.readPreviousCredentials();
  if (credentials && (
    credentials.projectId !== pending.projectId ||
    credentials.clientId !== pending.clientId
  )) {
    throw new Error("Pending operator cleanup credential does not match its recorded client and project.");
  }
  if (
    !credentials ||
    credentials.projectId !== pending.projectId ||
    credentials.clientId !== pending.clientId
  ) {
    const membershipId = pending.membershipId ?? await input.adapter.resolveMembership(
      pending.projectId,
      pending.clientId,
    );
    if (!allowUncredentialedRevocation) {
      throw pendingCleanupRecoveryError(pending.projectId, pending.clientId, membershipId);
    }
    await input.adapter.revoke(pending.projectId, pending.clientId, membershipId);
  } else {
    const membershipId = pending.membershipId ?? await input.adapter.resolveMembership(
      pending.projectId,
      pending.clientId,
    );
    if (!pending.membershipId) {
      state = {
        ...state,
        updatedAt: timestamp(input.now),
        pendingCleanup: { ...pending, membershipId },
      };
      input.store.writeState(state);
    }
    await input.adapter.revoke(pending.projectId, pending.clientId, membershipId, credentials);
  }
  finishCleanupState(input.store, state, timestamp(input.now));
  input.store.removePreviousCredentials();
}

async function recoverUnrecordedPreviousCredential(
  input: {
    readonly projectId: string;
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  projectId: string,
  state: OperatorIdentityState | undefined,
): Promise<{ state: OperatorIdentityState | undefined; completed: boolean }> {
  const credentials = input.store.readPreviousCredentials();
  if (!credentials) return { state, completed: false };
  const referencedByCleanup = state?.pendingCleanup?.projectId === credentials.projectId &&
    state.pendingCleanup.clientId === credentials.clientId;
  const referencedByRotation = state?.projectId === credentials.projectId &&
    state.pendingRevocation?.clientId === credentials.clientId;
  if (referencedByCleanup || referencedByRotation) return { state, completed: false };
  if (credentials.projectId !== projectId) {
    throw new Error(
      `Unrecorded operator cleanup credential targets project ${credentials.projectId}, not requested project ${projectId}.`,
    );
  }
  if (state?.pendingCleanup || state?.pendingRevocation) {
    throw new Error("Unrecorded operator cleanup credential conflicts with the recorded pending lifecycle operation.");
  }
  const now = timestamp(input.now);
  const pendingCleanup = { projectId, clientId: credentials.clientId };
  const recoveryState: OperatorIdentityState = state
    ? { ...state, updatedAt: now, pendingCleanup }
    : {
        version: 1,
        status: "cleanup-pending",
        projectId,
        clientId: credentials.clientId,
        createdAt: now,
        updatedAt: now,
        replacementReason: "initial-setup",
        pendingCleanup,
      };
  input.store.writeState(recoveryState);
  await finishPendingCleanup(input, recoveryState);
  return { state: input.store.readState(), completed: true };
}

async function cleanupFailedCreation(
  input: {
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  failure: {
    readonly credentials: OperatorCredentials;
    readonly replacementReason: OperatorReplacementReason;
    readonly priorState?: OperatorIdentityState;
    readonly previousClientId?: string;
    readonly verificationError: unknown;
  },
): Promise<never> {
  let membershipId = verificationMembershipId(failure.verificationError);
  let resolutionError: Error | undefined;
  if (!membershipId) {
    try {
      membershipId = await input.adapter.resolveMembership(
        failure.credentials.projectId,
        failure.credentials.clientId,
      );
    } catch (error) {
      resolutionError = asError(error);
    }
  }
  const now = timestamp(input.now);
  const pendingCleanup = {
    projectId: failure.credentials.projectId,
    clientId: failure.credentials.clientId,
    ...(membershipId ? { membershipId } : {}),
  };
  const pendingState: OperatorIdentityState = failure.priorState
    ? { ...failure.priorState, updatedAt: now, pendingCleanup }
    : {
        version: 1,
        status: "cleanup-pending",
        projectId: failure.credentials.projectId,
        clientId: failure.credentials.clientId,
        ...(membershipId ? { membershipId } : {}),
        createdAt: now,
        updatedAt: now,
        replacementReason: failure.replacementReason,
        ...(failure.previousClientId ? { previousClientId: failure.previousClientId } : {}),
        pendingCleanup,
      };
  input.store.writePreviousCredentials(failure.credentials);
  input.store.writeState(pendingState);

  let cleanupError: Error | undefined;
  try {
    await input.adapter.revoke(
      failure.credentials.projectId,
      failure.credentials.clientId,
      membershipId,
      failure.credentials,
    );
  } catch (error) {
    cleanupError = asError(error);
  }
  if (cleanupError || resolutionError) {
    const errors = [asError(failure.verificationError), resolutionError, cleanupError].filter(
      (error): error is Error => Boolean(error),
    );
    throw new AggregateError(
      errors,
      `Operator verification failed and cleanup is pending: ${errors.map((error) => error.message).join("; ")}`,
    );
  }

  if (failure.priorState) input.store.writeState(failure.priorState);
  else input.store.removeState();
  input.store.removePreviousCredentials();
  throw failure.verificationError;
}

async function finishPendingEmergencyRevocation(
  input: {
    readonly projectId: string;
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
    readonly reason: "credential-exposure";
  },
  state: OperatorIdentityState,
  allowUncredentialedRevocation: boolean,
): Promise<{ state: OperatorIdentityState }> {
  const pending = state.pendingEmergencyRevocation;
  if (!pending) throw new Error("Operator emergency revocation target was not persisted.");
  const storedCredentials = input.store.readCredentials();
  if (storedCredentials && (
    storedCredentials.projectId !== state.projectId ||
    storedCredentials.clientId !== pending.clientId
  )) {
    throw new Error("Operator credential file does not match the pending emergency revocation target.");
  }
  const credentials = storedCredentials &&
    storedCredentials.projectId === state.projectId &&
    storedCredentials.clientId === pending.clientId
    ? storedCredentials
    : undefined;
  if (credentials) {
    await input.adapter.revoke(state.projectId, pending.clientId, pending.membershipId, credentials);
  } else if (await input.adapter.clientExists(state.projectId, pending.clientId)) {
    const membershipId = pending.membershipId ?? await input.adapter.resolveMembership(
      state.projectId,
      pending.clientId,
    );
    if (!allowUncredentialedRevocation) {
      throw pendingCleanupRecoveryError(state.projectId, pending.clientId, membershipId);
    }
    await input.adapter.revoke(state.projectId, pending.clientId, membershipId);
  }
  const now = timestamp(input.now);
  const { pendingEmergencyRevocation: _pendingEmergencyRevocation, ...completedState } = state;
  const revokedState: OperatorIdentityState = {
    ...completedState,
    status: "revoked",
    updatedAt: now,
    revokedAt: now,
    revocationReason: input.reason,
  };
  input.store.writeState(revokedState);
  input.store.removeCredentials();
  return { state: revokedState };
}

function finishCleanupState(
  store: OperatorIdentityStore,
  state: OperatorIdentityState,
  updatedAt: string,
): void {
  if (state.status === "cleanup-pending") {
    store.removeState();
    return;
  }
  const { pendingCleanup: _pendingCleanup, ...restored } = state;
  store.writeState({ ...restored, updatedAt });
}

function pendingCleanupRecoveryError(
  projectId: string,
  clientId: string,
  membershipId: string,
): Error {
  return new Error(
    `Recorded ${OPERATOR_CLIENT_RESOURCE_TYPE}/${clientId} and ProjectMembership/${membershipId} still exist; ` +
    `finish their exact cleanup with npm run operator-identity -- --finish-pending-cleanup --project ${projectId}.`,
  );
}

async function verifyCreatedIdentity(
  input: {
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  creation: {
    readonly credentials: OperatorCredentials;
    readonly replacementReason: OperatorReplacementReason;
    readonly priorState?: OperatorIdentityState;
    readonly previousClientId?: string;
  },
): Promise<VerifiedOperatorSession> {
  try {
    return await input.adapter.verify(creation.credentials);
  } catch (error) {
    return cleanupFailedCreation(input, { ...creation, verificationError: error });
  }
}

function withoutPendingRevocation(
  state: OperatorIdentityState,
  updatedAt: string,
): OperatorIdentityState {
  const { pendingRevocation: _pendingRevocation, ...completed } = state;
  return { ...completed, updatedAt };
}

function matchingActiveCredentials(
  state: OperatorIdentityState,
  credentials: OperatorCredentials | undefined,
): OperatorCredentials {
  if (!credentials) {
    throw new Error("Active operator identity has no matching credential file; refusing to recreate it implicitly.");
  }
  if (credentials.projectId !== state.projectId || credentials.clientId !== state.clientId) {
    throw new Error("Operator credential file does not match active lifecycle state; refusing to choose one implicitly.");
  }
  return credentials;
}

async function createAndPersist(
  input: {
    readonly adapter: OperatorIdentityAdapter;
    readonly store: OperatorIdentityStore;
    readonly now?: () => string;
  },
  projectId: string,
  replacementReason: OperatorReplacementReason,
  previousClientId?: string,
  priorState?: OperatorIdentityState,
): Promise<{ accessToken: string; state: OperatorIdentityState }> {
  const created = await input.adapter.create(projectId);
  const credentials: OperatorCredentials = {
    projectId,
    clientId: created.clientId,
    clientSecret: created.clientSecret,
  };
  const verified = await verifyCreatedIdentity(input, {
    credentials,
    replacementReason,
    priorState,
    previousClientId,
  });
  const now = timestamp(input.now);
  const state: OperatorIdentityState = {
    version: 1,
    status: "active",
    projectId,
    clientId: created.clientId,
    membershipId: verified.membershipId,
    createdAt: now,
    updatedAt: now,
    replacementReason,
    ...(previousClientId ? { previousClientId } : {}),
  };
  input.store.writeCredentials(credentials);
  input.store.writeState(state);
  return { accessToken: verified.accessToken, state };
}

function readCredentialFile(path: string): OperatorCredentials | undefined {
  if (!existsSync(path)) return undefined;
  assertPrivateRegularFile(path);
  const values = Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
  return {
    projectId: requiredValue(values.ODOS_OPERATOR_PROJECT_ID, "ODOS_OPERATOR_PROJECT_ID"),
    clientId: requiredValue(values.ODOS_OPERATOR_CLIENT_ID, "ODOS_OPERATOR_CLIENT_ID"),
    clientSecret: requiredValue(values.ODOS_OPERATOR_CLIENT_SECRET, "ODOS_OPERATOR_CLIENT_SECRET"),
  };
}

function readStateFile(path: string): OperatorIdentityState | undefined {
  if (!existsSync(path)) return undefined;
  assertPrivateRegularFile(path);
  const state = JSON.parse(readFileSync(path, "utf8")) as OperatorIdentityState;
  if (
    state.version !== 1 ||
    !["active", "revoked", "cleanup-pending"].includes(state.status) ||
    !state.projectId?.trim() ||
    !state.clientId?.trim()
  ) {
    throw new Error("Operator identity lifecycle state is malformed.");
  }
  return state;
}

function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function assertPrivateRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Operator identity file must be a regular file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Operator identity file must use mode 0600: ${path}`);
  }
}

function requiredProjectId(value: string): string {
  return requiredValue(value, "operator project id");
}

function requiredValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function timestamp(now: (() => string) | undefined): string {
  return now?.() ?? new Date().toISOString();
}

function localBaseUrl(value: string): string {
  const baseUrl = value.replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  return baseUrl;
}

function membershipVerifier(postgresUrl: string | undefined) {
  return (input: { projectId: string; clientId: string; membershipId: string }) =>
    verifyOperatorMembershipFromPostgres({
      postgresUrl: postgresUrl ?? process.env.ODOS_POSTGRES_URL ?? DEFAULT_OPERATOR_POSTGRES_URL,
      ...input,
    });
}

function membershipResolver(postgresUrl: string | undefined) {
  return (input: { projectId: string; clientId: string }) =>
    findOperatorMembershipFromPostgres({
      postgresUrl: postgresUrl ?? process.env.ODOS_POSTGRES_URL ?? DEFAULT_OPERATOR_POSTGRES_URL,
      ...input,
    });
}

function verificationMembershipId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { membershipId?: unknown }).membershipId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function resolveCliProjectId(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const projectIndex = args.indexOf("--project");
  const explicit = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
  if (explicit?.trim()) return explicit.trim();
  if (env.MEDPLUM_PROJECT_ID?.trim()) return env.MEDPLUM_PROJECT_ID.trim();
  const setupStatePath = env.ODOS_SETUP_STATE_PATH ?? resolve(process.cwd(), ".odos-setup-state.json");
  if (existsSync(setupStatePath)) {
    const setupState = JSON.parse(readFileSync(setupStatePath, "utf8")) as { projectId?: string };
    if (setupState.projectId?.trim()) return setupState.projectId.trim();
  }
  throw new Error("Operator identity requires --project <project-id>, MEDPLUM_PROJECT_ID, or setup state with projectId.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runOperatorIdentityCli();
    console.log(result.state
      ? `Operator identity ${result.action}: project=${result.state.projectId} client=${result.state.clientId} status=${result.state.status}`
      : `Operator identity ${result.action}: cleanup complete`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
