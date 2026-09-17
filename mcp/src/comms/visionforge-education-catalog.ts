import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  educationItemSchema, loadDefaultEducationCatalogLedger, loadDefaultEducationCatalogReader,
  withSeedLifecycle, type EducationCatalogLifecycleReader, type EducationCatalogReader,
} from "./education-catalog.js";
import {
  PgEducationCatalogSnapshotStore, type EducationCatalogSnapshot, type EducationCatalogSnapshotStore,
  type LocalEducationCatalogEntry,
} from "./education-catalog-snapshot-store.js";

export interface EducationCatalogStatus {
  source: "seed-placeholder" | "visionforge";
  state: "seed-placeholder" | "misconfigured" | "unavailable" | "current" | "last-good";
  practiceId: string | null;
  asOf: string | null;
  acceptedAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptOutcome: "accepted" | "not-modified" | "refused" | null;
  lastRefusalCode: string | null;
  counts: { active: number; retained: number; withdrawn: number };
}
export interface RefreshResult {
  outcome: "accepted" | "not-modified" | "refused" | "seed-placeholder";
  refusalCode?: string;
}
export interface EducationCatalogRuntime extends EducationCatalogLifecycleReader {
  ready(): Promise<void>;
  refresh(): Promise<RefreshResult>;
  status(): EducationCatalogStatus;
  close(): Promise<void>;
}
export interface VisionForgeCatalogConfig { baseUrl: string; practiceId: string; token: string }

const timestamp = z.string().datetime({ offset: true });
const lifecycleSchema = z.object({
  state: z.enum(["active", "retained", "withdrawn"]), reviewedAt: timestamp, publishedAt: timestamp,
  retiredAt: timestamp.optional(), withdrawnAt: timestamp.optional(), withdrawnReason: z.string().nullable().optional(),
  supersededBy: z.number().int().positive().optional(),
}).passthrough();
const entrySchema = z.object({ item: educationItemSchema, lifecycle: lifecycleSchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough();
const envelopeSchema = z.object({
  contractVersion: z.literal(2), status: z.literal("published"), practiceId: z.string(),
  origins: z.object({ education: z.string().url() }).passthrough(), asOf: timestamp.nullable(),
  entries: z.array(entrySchema).max(1000),
}).passthrough();
const localCopySchema = z.array(entrySchema.extend({ absentUpstream: z.boolean(), asOf: timestamp.nullable() }));
const key = (entry: Pick<LocalEducationCatalogEntry, "item">) => `${entry.item.id}@${entry.item.version}`;
const effectiveLifecycle = (entry: LocalEducationCatalogEntry) => entry.lifecycle.state === "withdrawn"
  ? "withdrawn" : entry.absentUpstream ? "retained" : entry.lifecycle.state;

export function seedEducationCatalogStatus(reader: EducationCatalogReader): EducationCatalogStatus {
  return { source: "seed-placeholder", state: "seed-placeholder", practiceId: null, asOf: null, acceptedAt: null,
    lastAttemptAt: null, lastAttemptOutcome: null, lastRefusalCode: null,
    counts: { active: reader.list().length, retained: 0, withdrawn: 0 } };
}

export function createEducationCatalogFromEnv(
  env: Record<string, string | undefined>,
  options: { store?: EducationCatalogSnapshotStore; fetch?: typeof fetch; log?: (message: string) => void } = {},
): EducationCatalogRuntime {
  const names = ["VISIONFORGE_BASE_URL", "VISIONFORGE_PRACTICE_ID", "VISIONFORGE_SEAM_TOKEN"] as const;
  if (names.every(name => env[name] === undefined)) {
    const reader = withSeedLifecycle(loadDefaultEducationCatalogReader());
    return { ...reader, ready: async () => {}, close: async () => {}, refresh: async () => ({ outcome: "seed-placeholder" }), status: () => seedEducationCatalogStatus(reader) };
  }
  const invalid = new Set<string>(names.filter(name => !env[name]));
  let base: URL | undefined;
  try {
    base = new URL(env.VISIONFORGE_BASE_URL ?? "");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) invalid.add(names[0]);
  } catch { invalid.add(names[0]); }
  if (!/^[A-Za-z0-9_-]+$/.test(env.VISIONFORGE_PRACTICE_ID ?? "") || env.VISIONFORGE_PRACTICE_ID === "platform") invalid.add(names[1]);
  if (/\s/.test(env.VISIONFORGE_SEAM_TOKEN ?? "")) invalid.add(names[2]);
  if (invalid.size) {
    (options.log ?? console.error)(`odos-mcp: education catalog misconfigured: ${[...invalid].join(", ")}`);
    const empty = withSeedLifecycle({ list: () => [], get: () => undefined });
    return { ...empty, ready: async () => {}, close: async () => {},
      refresh: async () => ({ outcome: "refused", refusalCode: "misconfigured" }),
      status: () => ({ ...seedEducationCatalogStatus(empty), source: "visionforge", state: "misconfigured" }),
    };
  }
  const ownedStore = options.store ? undefined : new PgEducationCatalogSnapshotStore({ postgresUrl: env.ODOS_POSTGRES_URL });
  const reader = createVisionForgeEducationCatalogReader({ baseUrl: base!.href.replace(/\/$/, ""), practiceId: env.VISIONFORGE_PRACTICE_ID!, token: env.VISIONFORGE_SEAM_TOKEN! }, options.store ?? ownedStore!, options.fetch);
  return { ...reader, close: async () => { await ownedStore?.close(); } };
}

export function createVisionForgeEducationCatalogReader(
  config: VisionForgeCatalogConfig, store: EducationCatalogSnapshotStore, fetcher: typeof fetch = fetch,
): EducationCatalogRuntime {
  const verifiedCodes = new Set(loadDefaultEducationCatalogLedger().diagnosisCodes.map(({ code }) => code));
  let snapshot: EducationCatalogSnapshot | undefined;
  let attempt: Pick<EducationCatalogStatus, "lastAttemptAt" | "lastAttemptOutcome" | "lastRefusalCode"> = { lastAttemptAt: null, lastAttemptOutcome: null, lastRefusalCode: null };
  let readyPromise: Promise<void> | undefined;
  let inFlight: Promise<RefreshResult> | undefined;
  function ready(): Promise<void> {
    return readyPromise ??= (async () => {
      try {
        const row = await store.load(config.practiceId);
        if (row) {
          localCopySchema.parse(row.localCopy);
          if (row.practiceId !== config.practiceId) throw new Error("Stored practice mismatch");
          snapshot = structuredClone(row);
          attempt = { lastAttemptAt: row.lastAttemptAt, lastAttemptOutcome: row.lastAttemptOutcome, lastRefusalCode: row.lastRefusalCode };
        }
      } catch { snapshot = undefined; }
    })();
  }
  async function recordAttempt(outcome: "refused" | "not-modified", refusalCode: string | null, at: string): Promise<RefreshResult> {
    attempt = { lastAttemptAt: at, lastAttemptOutcome: outcome, lastRefusalCode: refusalCode };
    try { await store.recordAttempt(config.practiceId, { at, outcome, refusalCode }); }
    catch { attempt = { lastAttemptAt: at, lastAttemptOutcome: "refused", lastRefusalCode: "storage-unavailable" }; }
    return { outcome: attempt.lastAttemptOutcome!, ...(attempt.lastRefusalCode ? { refusalCode: attempt.lastRefusalCode } : {}) };
  }
  function validate(input: unknown): { refusalCode: string } | { localCopy: LocalEducationCatalogEntry[]; asOf: string | null } {
    const value = input as Partial<z.infer<typeof envelopeSchema>> | null;
    if (!value || value.contractVersion !== 2 || value.status !== "published") return { refusalCode: "contract-version-unsupported" };
    if (value.practiceId !== config.practiceId) return { refusalCode: "practice-mismatch" };
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) return { refusalCode: "entry-invalid" };
    const envelope = parsed.data;
    const previous = new Map((snapshot?.localCopy ?? []).map(entry => [key(entry), entry]));
    const seen = new Set<string>();
    const localCopy: LocalEducationCatalogEntry[] = [];
    for (const entry of envelope.entries) {
      const id = key(entry);
      if (seen.has(id)) return { refusalCode: "entry-invalid" };
      seen.add(id);
      if (entry.item.dxCodes.some(code => !verifiedCodes.has(code))) return { refusalCode: "dx-code-unverified" };
      const origin = new URL(envelope.origins.education);
      if (Object.values(entry.item.urls).some(url => url && (new URL(url).protocol !== "https:" || new URL(url).host !== origin.host || new URL(url).username || new URL(url).password))) return { refusalCode: "url-origin-mismatch" };
      const prior = previous.get(id);
      if (prior) {
        if (!isDeepStrictEqual(prior.item, entry.item) || prior.manifestSha256 !== entry.manifestSha256) return { refusalCode: "meaning-changed" };
        const from = prior.lifecycle.state; const to = entry.lifecycle.state;
        if (!(from === to || (from === "active" && (to === "retained" || to === "withdrawn")) || (from === "retained" && to === "withdrawn"))) return { refusalCode: "lifecycle-regressed" };
      }
      localCopy.push({ item: structuredClone(entry.item), lifecycle: structuredClone(entry.lifecycle), manifestSha256: entry.manifestSha256, absentUpstream: false, asOf: envelope.asOf });
    }
    if (envelope.entries.length === 0 && previous.size > 0) return { refusalCode: "catalog-emptied" };
    for (const [id, entry] of previous) {
      if (!seen.has(id)) localCopy.push({ ...structuredClone(entry), absentUpstream: true });
    }
    return { localCopy, asOf: envelope.asOf };
  }
  async function refreshOnce(): Promise<RefreshResult> {
    await ready();
    const at = new Date().toISOString();
    const signal = AbortSignal.timeout(10_000);
    let response: Response; let input: unknown;
    try {
      response = await fetcher(`${config.baseUrl.replace(/\/$/, "")}/v1/practices/${encodeURIComponent(config.practiceId)}/education/catalog`, {
        headers: { Authorization: `Bearer ${config.token}`, ...(snapshot?.etag ? { "If-None-Match": snapshot.etag } : {}) },
        signal, redirect: "error",
      });
      if (response.status === 304) return recordAttempt("not-modified", null, at);
      if (response.status !== 200) { await response.body?.cancel(); return recordAttempt("refused", `http-${response.status}`, at); }
      try { input = await response.json(); }
      catch { return recordAttempt("refused", signal.aborted ? "timeout" : "not-json", at); }
    } catch { return recordAttempt("refused", signal.aborted ? "timeout" : "network", at); }
    const validated = validate(input);
    if ("refusalCode" in validated) return recordAttempt("refused", validated.refusalCode, at);
    const accepted: EducationCatalogSnapshot = { practiceId: config.practiceId, envelope: input, localCopy: validated.localCopy,
      asOf: validated.asOf, etag: response.headers.get("etag"), acceptedAt: at, lastAttemptAt: at, lastAttemptOutcome: "accepted", lastRefusalCode: null };
    try { await store.accept(accepted); }
    catch { return recordAttempt("refused", "storage-unavailable", at); }
    snapshot = accepted;
    attempt = { lastAttemptAt: at, lastAttemptOutcome: "accepted", lastRefusalCode: null };
    return { outcome: "accepted" };
  }
  return {
    ready, close: async () => {},
    refresh: () => inFlight ??= refreshOnce().finally(() => { inFlight = undefined; }),
    list: () => structuredClone((snapshot?.localCopy ?? []).filter(entry => effectiveLifecycle(entry) === "active").map(entry => entry.item)),
    get(id, version) {
      const candidates = (snapshot?.localCopy ?? []).filter(entry => entry.item.id === id && (version === undefined ? effectiveLifecycle(entry) === "active" : entry.item.version === version && effectiveLifecycle(entry) !== "withdrawn"));
      const selected = candidates.sort((a, b) => b.item.version - a.item.version)[0];
      return selected ? structuredClone(selected.item) : undefined;
    },
    getForNewWork(id, version) {
      const entry = snapshot?.localCopy.find(entry => entry.item.id === id && entry.item.version === version && effectiveLifecycle(entry) === "active");
      return entry ? structuredClone(entry.item) : undefined;
    },
    lifecycle(id, version) {
      const entry = snapshot?.localCopy.find(entry => entry.item.id === id && entry.item.version === version);
      return entry ? effectiveLifecycle(entry) : undefined;
    },
    status() {
      const counts = { active: 0, retained: 0, withdrawn: 0 };
      for (const entry of snapshot?.localCopy ?? []) counts[effectiveLifecycle(entry)]++;
      return { source: "visionforge", state: snapshot ? (attempt.lastAttemptOutcome === "refused" ? "last-good" : "current") : "unavailable",
        practiceId: config.practiceId, asOf: snapshot?.asOf ?? null, acceptedAt: snapshot?.acceptedAt ?? null, ...attempt, counts };
    },
  };
}
