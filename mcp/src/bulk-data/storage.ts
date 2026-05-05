import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Resource } from "@medplum/fhirtypes";
import { generateBulkExportJobId, assertBulkExportIdentifierIsOpaque } from "./job-id-generator.js";
import type {
  BulkDataManifest,
  BulkDataManifestOutput,
  BulkDataRuntimeConfig,
  BulkExportAuthorizationContext,
  BulkExportEndpoint,
  BulkExportJob,
  BulkExportStatus,
} from "./types.js";
import { serializeBulkDataNdjson } from "./output/ndjson-serializer.js";

export interface BulkExportJobStore {
  create(input: CreateBulkExportJobInput): Promise<BulkExportJob>;
  read(id: string): Promise<BulkExportJob | undefined>;
  updateStatus(id: string, status: BulkExportStatus): Promise<BulkExportJob | undefined>;
  complete(id: string, resourcesByType: ReadonlyMap<string, readonly Resource[]>): Promise<BulkExportJob>;
  remove(id: string): Promise<void>;
  readOutput(job: BulkExportJob, resourceType: string): Promise<string | undefined>;
}

export interface CreateBulkExportJobInput {
  readonly kickoffEndpoint: BulkExportEndpoint | `Group/${string}/$export`;
  readonly requestingClientId: string;
  readonly requestingTokenHash: string;
  readonly requestedTypes?: readonly string[];
  readonly requestedSince?: string;
  readonly groupId?: string;
  readonly cohortPatientIds?: readonly string[];
  readonly authorizationContext: BulkExportAuthorizationContext;
}

export class LocalBulkExportJobStore implements BulkExportJobStore {
  private readonly jobs = new Map<string, BulkExportJob>();

  constructor(private readonly config: BulkDataRuntimeConfig) {}

  async create(input: CreateBulkExportJobInput): Promise<BulkExportJob> {
    const id = generateBulkExportJobId();
    const now = new Date();
    const retentionDays = Math.max(1, Math.min(this.config.retentionDays, 90));
    const outputDir = resolve(this.config.outputRoot, id);
    assertBulkExportIdentifierIsOpaque(id);
    const job: BulkExportJob = {
      id,
      kickoffEndpoint: input.kickoffEndpoint,
      requestingClientId: input.requestingClientId,
      requestingTokenHash: input.requestingTokenHash,
      status: "accepted",
      transactionTime: now.toISOString(),
      requestedTypes: input.requestedTypes,
      requestedSince: input.requestedSince,
      outputDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      retentionUntil: new Date(now.getTime() + retentionDays * 24 * 60 * 60_000).toISOString(),
      requiresAccessToken: true,
      groupId: input.groupId,
      cohortPatientIds: input.cohortPatientIds,
      authorizationContext: input.authorizationContext,
    };
    mkdirSync(outputDir, { recursive: true });
    this.jobs.set(id, job);
    return job;
  }

  async read(id: string): Promise<BulkExportJob | undefined> {
    return this.jobs.get(id);
  }

  async updateStatus(id: string, status: BulkExportStatus): Promise<BulkExportJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }
    job.status = status;
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async complete(id: string, resourcesByType: ReadonlyMap<string, readonly Resource[]>): Promise<BulkExportJob> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Bulk Data export job not found: ${id}`);
    }
    const output: BulkDataManifestOutput[] = [];
    for (const [resourceType, resources] of resourcesByType) {
      if (!resources.length) {
        continue;
      }
      const filename = `${resourceType}.ndjson`;
      writeFileSync(join(job.outputDir, filename), serializeBulkDataNdjson(resources));
      output.push({
        type: resourceType,
        url: `${this.config.practicePublicBaseUrl.replace(/\/$/, "")}/bulk-export/file/${job.id}/${filename}`,
        count: resources.length,
      });
    }
    const manifest: BulkDataManifest = {
      transactionTime: job.transactionTime,
      request: job.kickoffEndpoint,
      requiresAccessToken: true,
      output,
      error: [],
    };
    job.manifest = manifest;
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      rmSync(job.outputDir, { force: true, recursive: true });
    }
    this.jobs.delete(id);
  }

  async readOutput(job: BulkExportJob, resourceType: string): Promise<string | undefined> {
    try {
      return readFileSync(join(job.outputDir, `${resourceType}.ndjson`), "utf8");
    } catch {
      return undefined;
    }
  }
}
