import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface Credentials {
  projectId: string;
  clientId: string;
  clientSecret: string;
}

interface IdentityState {
  version: 1;
  status: "active" | "revoked" | "cleanup-pending";
  projectId: string;
  clientId: string;
  membershipId?: string;
  createdAt: string;
  updatedAt: string;
  replacementReason: "initial-setup" | "rotation" | "project-rebuild" | "post-revocation";
  previousClientId?: string;
  pendingRevocation?: { clientId: string; membershipId?: string };
  pendingCleanup?: { projectId: string; clientId: string; membershipId?: string };
  pendingEmergencyRevocation?: { clientId: string; membershipId?: string };
  revokedAt?: string;
  revocationReason?: "credential-exposure";
}

class MemoryStore {
  credentials?: Credentials;
  previousCredentials?: Credentials;
  state?: IdentityState;

  readCredentials(): Credentials | undefined {
    return this.credentials ? structuredClone(this.credentials) : undefined;
  }

  writeCredentials(credentials: Credentials): void {
    this.credentials = structuredClone(credentials);
  }

  removeCredentials(): void {
    this.credentials = undefined;
  }

  readPreviousCredentials(): Credentials | undefined {
    return this.previousCredentials ? structuredClone(this.previousCredentials) : undefined;
  }

  writePreviousCredentials(credentials: Credentials): void {
    this.previousCredentials = structuredClone(credentials);
  }

  removePreviousCredentials(): void {
    this.previousCredentials = undefined;
  }

  readState(): IdentityState | undefined {
    return this.state ? structuredClone(this.state) : undefined;
  }

  writeState(state: IdentityState): void {
    this.state = structuredClone(state);
  }

  removeState(): void {
    this.state = undefined;
  }
}

class FakeAdapter {
  readonly actions: string[] = [];
  readonly clients = new Set<string>();
  readonly memberships = new Map<string, string>();
  nextClient = 1;
  rejectVerification?: string;
  rejectVerificationForClientId?: string;
  rejectRevocation?: string;
  partialRevocationFailure?: "client" | "membership";

  async create(projectId: string): Promise<{ clientId: string; clientSecret: string }> {
    this.actions.push(`create:${projectId}`);
    const suffix = this.nextClient++;
    const clientId = `client-${suffix}`;
    this.clients.add(clientId);
    this.memberships.set(clientId, `membership-${clientId}`);
    return { clientId, clientSecret: `secret-${suffix}` };
  }

  async resolveMembership(projectId: string, clientId: string): Promise<string> {
    this.actions.push(`resolve:${projectId}:${clientId}`);
    const membershipId = this.memberships.get(clientId);
    if (!membershipId) throw new Error("Operator membership is missing.");
    return membershipId;
  }

  async verify(credentials: Credentials): Promise<{ accessToken: string; membershipId: string }> {
    this.actions.push(`verify:${credentials.projectId}:${credentials.clientId}`);
    if (this.rejectVerification || this.rejectVerificationForClientId === credentials.clientId) {
      throw new Error(this.rejectVerification ?? "Operator membership verification failed.");
    }
    return { accessToken: `token-${credentials.clientId}`, membershipId: `membership-${credentials.clientId}` };
  }

  async revoke(projectId: string, clientId: string, membershipId?: string): Promise<void> {
    this.actions.push(`revoke:${projectId}:${clientId}:${membershipId ?? "missing"}`);
    if (this.rejectRevocation) throw new Error(this.rejectRevocation);
    if (this.partialRevocationFailure === "client") {
      this.memberships.delete(clientId);
      this.partialRevocationFailure = undefined;
      throw new Error("client deletion failed");
    }
    if (this.partialRevocationFailure === "membership") {
      this.clients.delete(clientId);
      this.partialRevocationFailure = undefined;
      throw new Error("membership deletion failed");
    }
    this.clients.delete(clientId);
    this.memberships.delete(clientId);
  }
}

async function subject() {
  const loaded = await import("../../scripts/" + "operator-identity.ts").catch(() => undefined);
  assert.ok(loaded, "operator identity lifecycle module must exist");
  return loaded as unknown as {
    ensureOperatorIdentity(input: {
      projectId: string;
      adapter: FakeAdapter;
      store: MemoryStore;
      now: () => string;
    }): Promise<{ accessToken: string; state: IdentityState; reused: boolean }>;
    rotateOperatorIdentity(input: {
      projectId: string;
      adapter: FakeAdapter;
      store: MemoryStore;
      now: () => string;
    }): Promise<{ accessToken: string; state: IdentityState }>;
    revokeOperatorIdentity(input: {
      projectId: string;
      adapter: FakeAdapter;
      store: MemoryStore;
      now: () => string;
      reason: "credential-exposure";
    }): Promise<{ state: IdentityState }>;
    replaceRevokedOperatorIdentity(input: {
      projectId: string;
      adapter: FakeAdapter;
      store: MemoryStore;
      now: () => string;
    }): Promise<{ accessToken: string; state: IdentityState }>;
    createFileOperatorIdentityStore(input: {
      credentialPath: string;
      previousCredentialPath: string;
      statePath: string;
    }): MemoryStore;
  };
}

const NOW = "2026-08-18T18:00:00.000Z";

test("operator setup creates and verifies one policy-free client before persisting active state", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = new MemoryStore();

  const result = await lifecycle.ensureOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });

  assert.equal(result.reused, false);
  assert.equal(result.accessToken, "token-client-1");
  assert.deepEqual(adapter.actions, ["create:practice-1", "verify:practice-1:client-1"]);
  assert.deepEqual(store.credentials, {
    projectId: "practice-1",
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.deepEqual(store.state, {
    version: 1,
    status: "active",
    projectId: "practice-1",
    clientId: "client-1",
    membershipId: "membership-client-1",
    createdAt: NOW,
    updatedAt: NOW,
    replacementReason: "initial-setup",
  });
});

test("failed initial verification revokes the just-created client and membership without persisting them", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = new MemoryStore();
  adapter.rejectVerification = "Operator membership verification failed.";

  await assert.rejects(
    lifecycle.ensureOperatorIdentity({ projectId: "practice-1", adapter, store, now: () => NOW }),
    /membership verification failed/,
  );

  assert.deepEqual([...adapter.clients], []);
  assert.deepEqual([...adapter.memberships], []);
  assert.equal(store.credentials, undefined);
  assert.equal(store.previousCredentials, undefined);
  assert.equal(store.state, undefined);
});

test("failed verification cleanup persists the exact new identity for the next invocation", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = new MemoryStore();
  adapter.rejectVerification = "Operator membership verification failed.";
  adapter.rejectRevocation = "cleanup deletion failed";

  await assert.rejects(
    lifecycle.ensureOperatorIdentity({ projectId: "practice-1", adapter, store, now: () => NOW }),
    /cleanup deletion failed/,
  );

  assert.deepEqual(store.previousCredentials, {
    projectId: "practice-1",
    clientId: "client-1",
    clientSecret: "secret-1",
  });
  assert.deepEqual(store.state?.pendingCleanup, {
    projectId: "practice-1",
    clientId: "client-1",
    membershipId: "membership-client-1",
  });

  adapter.rejectVerification = undefined;
  adapter.rejectRevocation = undefined;
  const retried = await lifecycle.ensureOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });
  assert.equal(retried.state.clientId, "client-2");
  assert.deepEqual([...adapter.clients], ["client-2"]);
  assert.deepEqual([...adapter.memberships], [["client-2", "membership-client-2"]]);
  assert.equal(store.previousCredentials, undefined);
  assert.equal(store.state?.pendingCleanup, undefined);
});

test("operator setup reuses only a verified exact-project active identity", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "client-existing");

  const result = await lifecycle.ensureOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });

  assert.equal(result.reused, true);
  assert.equal(result.accessToken, "token-client-existing");
  assert.deepEqual(adapter.actions, ["verify:practice-1:client-existing"]);
});

test("operator setup fails closed when active state has missing credentials or a constrained membership", async () => {
  const lifecycle = await subject();
  const missingCredentials = activeStore("practice-1", "client-existing");
  missingCredentials.credentials = undefined;
  await assert.rejects(
    lifecycle.ensureOperatorIdentity({
      projectId: "practice-1",
      adapter: new FakeAdapter(),
      store: missingCredentials,
      now: () => NOW,
    }),
    /active operator identity has no matching credential file/i,
  );

  const constrainedStore = activeStore("practice-1", "client-existing");
  const constrainedAdapter = new FakeAdapter();
  constrainedAdapter.rejectVerification = "Operator membership carries AccessPolicy/policy-1.";
  await assert.rejects(
    lifecycle.ensureOperatorIdentity({
      projectId: "practice-1",
      adapter: constrainedAdapter,
      store: constrainedStore,
      now: () => NOW,
    }),
    /carries AccessPolicy\/policy-1/,
  );
  assert.equal(constrainedAdapter.actions.some((action) => action.startsWith("create:")), false);
});

test("project rebuild creates a new identity and records the old client without reusing it", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("old-project", "old-client");

  const result = await lifecycle.ensureOperatorIdentity({
    projectId: "new-project",
    adapter,
    store,
    now: () => NOW,
  });

  assert.equal(result.state.replacementReason, "project-rebuild");
  assert.equal(result.state.previousClientId, "old-client");
  assert.equal(result.state.projectId, "new-project");
  assert.deepEqual(adapter.actions, ["create:new-project", "verify:new-project:client-1"]);
});

test("rotation verifies the replacement before revoking the old client", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "old-client");

  const result = await lifecycle.rotateOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });

  assert.equal(result.state.replacementReason, "rotation");
  assert.equal(result.state.previousClientId, "old-client");
  assert.equal(store.previousCredentials, undefined);
  assert.deepEqual(adapter.actions, [
    "verify:practice-1:old-client",
    "create:practice-1",
    "verify:practice-1:client-1",
    "revoke:practice-1:old-client:membership-old-client",
  ]);
});

test("failed replacement verification removes only the replacement and restores the original active identity", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "old-client");
  adapter.clients.add("old-client");
  adapter.memberships.set("old-client", "membership-old-client");
  adapter.rejectVerificationForClientId = "client-1";

  await assert.rejects(
    lifecycle.rotateOperatorIdentity({ projectId: "practice-1", adapter, store, now: () => NOW }),
    /membership verification failed/i,
  );

  assert.equal(store.state?.clientId, "old-client");
  assert.equal(store.state?.pendingCleanup, undefined);
  assert.equal(store.credentials?.clientId, "old-client");
  assert.equal(store.previousCredentials, undefined);
  assert.deepEqual([...adapter.clients], ["old-client"]);
  assert.deepEqual([...adapter.memberships], [["old-client", "membership-old-client"]]);
});

test("a failed rotation revocation retains a private retry credential and resumes without creating another client", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "old-client");
  adapter.rejectRevocation = "old client deletion failed";

  await assert.rejects(
    lifecycle.rotateOperatorIdentity({ projectId: "practice-1", adapter, store, now: () => NOW }),
    /old client deletion failed/,
  );
  assert.equal(store.state?.clientId, "client-1");
  assert.deepEqual(store.previousCredentials, {
    projectId: "practice-1",
    clientId: "old-client",
    clientSecret: "secret-old-client",
  });

  adapter.rejectRevocation = undefined;
  const resumed = await lifecycle.rotateOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });
  assert.equal(resumed.state.clientId, "client-1");
  assert.equal(store.previousCredentials, undefined);
  assert.equal(adapter.actions.filter((action) => action.startsWith("create:")).length, 1);
});

test("credential-exposure revocation writes a tombstone and requires explicit replacement", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "old-client");

  const revoked = await lifecycle.revokeOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
    reason: "credential-exposure",
  });
  assert.equal(store.credentials, undefined);
  assert.equal(revoked.state.status, "revoked");
  assert.equal(revoked.state.revocationReason, "credential-exposure");
  await assert.rejects(
    lifecycle.ensureOperatorIdentity({
      projectId: "practice-1",
      adapter,
      store,
      now: () => NOW,
    }),
    /explicit replacement is required/i,
  );

  const replacement = await lifecycle.replaceRevokedOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
  });
  assert.equal(replacement.state.status, "active");
  assert.equal(replacement.state.replacementReason, "post-revocation");
  assert.equal(replacement.state.previousClientId, "old-client");
});

test("credential-exposure revocation persists the membership returned by its final verification", async () => {
  const lifecycle = await subject();
  const adapter = new FakeAdapter();
  const store = activeStore("practice-1", "old-client");
  delete store.state!.membershipId;
  adapter.clients.add("old-client");
  adapter.memberships.set("old-client", "membership-old-client");

  await lifecycle.revokeOperatorIdentity({
    projectId: "practice-1",
    adapter,
    store,
    now: () => NOW,
    reason: "credential-exposure",
  });

  assert.ok(adapter.actions.includes("revoke:practice-1:old-client:membership-old-client"));
});

for (const failure of ["client", "membership"] as const) {
  test(`credential-exposure revocation retries after ${failure} deletion fails second`, async () => {
    const lifecycle = await subject();
    const adapter = new FakeAdapter();
    const store = activeStore("practice-1", "old-client");
    adapter.clients.add("old-client");
    adapter.memberships.set("old-client", "membership-old-client");
    adapter.partialRevocationFailure = failure;

    await assert.rejects(
      lifecycle.revokeOperatorIdentity({
        projectId: "practice-1",
        adapter,
        store,
        now: () => NOW,
        reason: "credential-exposure",
      }),
      new RegExp(`${failure} deletion failed`),
    );
    assert.deepEqual(store.state?.pendingEmergencyRevocation, {
      clientId: "old-client",
      membershipId: "membership-old-client",
    });

    adapter.rejectVerification = "half-revoked identity cannot verify";
    const result = await lifecycle.revokeOperatorIdentity({
      projectId: "practice-1",
      adapter,
      store,
      now: () => NOW,
      reason: "credential-exposure",
    });

    assert.equal(result.state.status, "revoked");
    assert.equal(store.credentials, undefined);
    assert.deepEqual([...adapter.clients], []);
    assert.deepEqual([...adapter.memberships], []);
    assert.equal(
      adapter.actions.filter((action) => action === "verify:practice-1:old-client").length,
      1,
    );
  });
}

test("operator credentials and lifecycle state are stored as owner-only local files", async () => {
  const lifecycle = await subject();
  const dir = mkdtempSync(join(tmpdir(), "odos-operator-identity-"));
  const credentialPath = join(dir, ".odos", "operator.env");
  const previousCredentialPath = join(dir, ".odos", "operator-previous.env");
  const statePath = join(dir, ".odos", "operator-identity.json");
  try {
    const store = lifecycle.createFileOperatorIdentityStore({ credentialPath, previousCredentialPath, statePath });
    store.writeCredentials({ projectId: "practice-1", clientId: "client-1", clientSecret: "secret-1" });
    store.writePreviousCredentials({ projectId: "practice-1", clientId: "old-client", clientSecret: "old-secret" });
    store.writeState(activeStore("practice-1", "client-1").state!);

    assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
    assert.equal(statSync(previousCredentialPath).mode & 0o777, 0o600);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.equal(store.readCredentials()?.clientId, "client-1");
    assert.equal(store.readPreviousCredentials()?.clientId, "old-client");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function activeStore(projectId: string, clientId: string): MemoryStore {
  const store = new MemoryStore();
  store.credentials = { projectId, clientId, clientSecret: `secret-${clientId}` };
  store.state = {
    version: 1,
    status: "active",
    projectId,
    clientId,
    membershipId: `membership-${clientId}`,
    createdAt: "2026-08-18T17:00:00.000Z",
    updatedAt: "2026-08-18T17:00:00.000Z",
    replacementReason: "initial-setup",
  };
  return store;
}
