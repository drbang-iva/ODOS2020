import { randomBytes } from "node:crypto";
import type { Application, Request, Response } from "express";
import type { Basic, Patient } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { readCommsPreferenceCells, replaceCommsPreferenceCells } from "./suppression-gate.js";

const TOKEN_SYSTEM = "https://odos2020.com/fhir/NamingSystem/email-unsubscribe-token";
const ADDRESS_SYSTEM = "https://odos2020.com/fhir/NamingSystem/email-marketing-suppression-address";
const KIND_SYSTEM = "https://odos2020.com/fhir/CodeSystem/basic-resource-kind";
const DETAILS = "https://odos2020.com/fhir/StructureDefinition/odos-email-unsubscribe";
const TOKEN_RULE = /^[A-Za-z0-9_-]{8,128}$/;
const CONFIRM_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preferences</title></head><body><main><h1>Stop promotional emails</h1><p>Confirm to stop promotional emails to this inbox. Treatment, appointment and recall messages are unaffected.</p><form method="post" action=""><button type="submit" name="List-Unsubscribe" value="One-Click">Unsubscribe from promotional emails</button></form></main></body></html>';
const RECEIVED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preferences</title></head><body><main><h1>Request received</h1><p>If this link applies, promotional emails to this inbox have been stopped. Treatment, appointment and recall messages are unaffected.</p></main></body></html>';

export interface EmailUnsubscribeToken {
  token: string;
  email: string;
  patientReference: string;
  scope: "marketing-promo";
  issuedAt: string;
}

export interface EmailAddressSuppression {
  email: string;
  patientReference: string;
  scope: "marketing-promo";
  issuedAt: string;
  revokedAt: string;
}

export interface EmailUnsubscribeStore {
  create(record: EmailUnsubscribeToken): Promise<void>;
  find(token: string): Promise<EmailUnsubscribeToken | undefined>;
  suppressAddress(record: EmailAddressSuppression): Promise<EmailAddressSuppression>;
}

export async function issueUnsubscribeToken(input: {
  store: EmailUnsubscribeStore;
  publicBaseUrl: string;
  patientReference: string;
  email: string;
  now?: () => string;
}): Promise<{ token: string; url: string }> {
  const base = new URL(input.publicBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("Unsubscribe public base URL must use HTTPS without credentials, query or fragment.");
  }
  const token = randomBytes(18).toString("base64url");
  const record: EmailUnsubscribeToken = {
    token, email: normalizeEmail(input.email), patientReference: input.patientReference,
    scope: "marketing-promo", issuedAt: input.now?.() ?? new Date().toISOString(),
  };
  validateRecord(record);
  await input.store.create(record);
  return { token, url: `${input.publicBaseUrl.replace(/\/$/, "")}/comms/u/${token}` };
}

export function registerEmailUnsubscribeRoutes(
  app: Pick<Application, "get" | "post">,
  deps: {
    store: EmailUnsubscribeStore;
    fhir: Pick<MedplumClient, "read" | "update">;
    authenticateService?: () => Promise<void>;
    now?: () => string;
  },
): void {
  app.get("/comms/u/:token", (req: Request, res: Response) => {
    if (!validRouteToken(req)) { respond(res, 400, "Invalid link."); return; }
    respond(res, 200, CONFIRM_PAGE);
  });
  app.post("/comms/u/:token", async (req: Request, res: Response) => {
    if (!validRouteToken(req)) { respond(res, 400, "Invalid link."); return; }
    try {
      await deps.authenticateService?.();
      const record = await deps.store.find(String(req.params.token));
      if (record) {
        const receipt = await deps.store.suppressAddress({
          email: record.email, patientReference: record.patientReference, scope: record.scope,
          issuedAt: record.issuedAt, revokedAt: deps.now?.() ?? new Date().toISOString(),
        });
        await suppressPatient(deps.fhir, record.patientReference, receipt.revokedAt);
      }
      respond(res, 200, RECEIVED_PAGE);
    } catch {
      console.error("odos-mcp: email unsubscribe could not be completed.");
      respond(res, 503, "Request could not be completed. Please try again.");
    }
  });
}

async function suppressPatient(
  fhir: Pick<MedplumClient, "read" | "update">,
  patientReference: string,
  recordedAt: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const patient = await fhir.read<Patient>("Patient", patientReference.slice("Patient/".length));
    if (!patient.id || !patient.meta?.versionId) throw new Error("Unsubscribe requires a Patient id and version.");
    if (readCommsPreferenceCells(patient).some(cell => cell.purpose === "marketing-promo" && cell.channel === "email" && !cell.allowed)) return;
    const updated = replaceCommsPreferenceCells(patient, [{ purpose: "marketing-promo", channel: "email", allowed: false }], {
      setBy: { reference: patientReference }, surface: "email-unsubscribe", recordedAt,
    });
    try {
      await fhir.update<Patient>("Patient", patient.id, updated, { "If-Match": `W/"${patient.meta.versionId}"` });
      return;
    } catch (error) {
      if ((error as { status?: number }).status !== 412 || attempt === 4) throw error;
    }
  }
}

export function createInMemoryEmailUnsubscribeStore(): EmailUnsubscribeStore {
  const tokens = new Map<string, EmailUnsubscribeToken>();
  const addresses = new Map<string, EmailAddressSuppression>();
  return {
    async create(record) {
      if (tokens.has(record.token)) throw new Error("Unsubscribe token already exists.");
      tokens.set(record.token, structuredClone(record));
    },
    async find(token) {
      const record = tokens.get(token);
      return record ? structuredClone(record) : undefined;
    },
    async suppressAddress(record) {
      const email = normalizeEmail(record.email);
      if (!addresses.has(email)) addresses.set(email, structuredClone({ ...record, email }));
      return structuredClone(addresses.get(email)!);
    },
  };
}

export function createFhirEmailUnsubscribeStore(fhir: Pick<MedplumClient, "create" | "search">): EmailUnsubscribeStore {
  return {
    async create(record) {
      await fhir.create<Basic>(resource(record, "email-unsubscribe-token", TOKEN_SYSTEM, record.token), {
        "If-None-Exist": conditionalIdentifier(TOKEN_SYSTEM, record.token),
      });
    },
    async find(token) {
      const found = await findRecord(fhir, TOKEN_SYSTEM, token, "email-unsubscribe-token");
      if (!found) return undefined;
      return { ...parseRecord(found), token };
    },
    async suppressAddress(record) {
      const email = normalizeEmail(record.email);
      // Conditional creation is the cross-process idempotency boundary; the winner's timestamp is retained.
      const saved = await fhir.create<Basic>(resource({ ...record, email }, "email-address-suppression", ADDRESS_SYSTEM, email), {
        "If-None-Exist": conditionalIdentifier(ADDRESS_SYSTEM, email),
      });
      return parseSuppression(saved);
    },
  };
}

export type EmailAddressSuppressionReader = (address: string, scope: "marketing-promo") => Promise<boolean>;

export function createEmailAddressSuppressionReader(fhir: Pick<MedplumClient, "search">): EmailAddressSuppressionReader {
  return async (address, scope) => scope === "marketing-promo" && (await readEmailAddressSuppression(fhir, address)) !== undefined;
}

export async function readEmailAddressSuppression(
  fhir: Pick<MedplumClient, "search">,
  email: string,
): Promise<EmailAddressSuppression | undefined> {
  const record = await findRecord(fhir, ADDRESS_SYSTEM, normalizeEmail(email), "email-address-suppression");
  return record ? parseSuppression(record) : undefined;
}

async function findRecord(fhir: Pick<MedplumClient, "search">, system: string, value: string, kind: string): Promise<Basic | undefined> {
  const bundle = await fhir.search<Basic>("Basic", { identifier: `${system}|${escapeSearch(value)}`, _count: "2" });
  const records = (bundle.entry ?? []).flatMap(entry => entry.resource ? [entry.resource] : []);
  if (records.length > 1 || bundle.link?.some(link => link.relation === "next")) throw new Error("Unsubscribe record is not unique.");
  const record = records[0];
  if (record && !record.code.coding?.some(coding => coding.system === KIND_SYSTEM && coding.code === kind)) {
    throw new Error("Unsubscribe record kind is invalid.");
  }
  return record;
}

function resource(record: Omit<EmailUnsubscribeToken, "token"> & { revokedAt?: string }, kind: string, system: string, value: string): Basic {
  validateRecord(record);
  return {
    resourceType: "Basic", identifier: [{ system, value }],
    code: { coding: [{ system: KIND_SYSTEM, code: kind }] },
    subject: { reference: record.patientReference }, created: record.issuedAt.slice(0, 10),
    extension: [{ url: DETAILS, extension: [
      { url: "email", valueString: record.email }, { url: "scope", valueCode: record.scope },
      { url: "issuedAt", valueInstant: record.issuedAt },
      ...(record.revokedAt ? [{ url: "revokedAt", valueInstant: record.revokedAt }] : []),
    ] }],
  };
}

function parseRecord(record: Basic): Omit<EmailUnsubscribeToken, "token"> {
  const parts = record.extension?.find(e => e.url === DETAILS)?.extension;
  const parsed = {
    email: parts?.find(e => e.url === "email")?.valueString ?? "",
    patientReference: record.subject?.reference ?? "",
    scope: parts?.find(e => e.url === "scope")?.valueCode as "marketing-promo",
    issuedAt: parts?.find(e => e.url === "issuedAt")?.valueInstant ?? "",
  };
  validateRecord(parsed);
  return parsed;
}

function parseSuppression(record: Basic): EmailAddressSuppression {
  const revokedAt = record.extension?.find(e => e.url === DETAILS)?.extension?.find(e => e.url === "revokedAt")?.valueInstant;
  if (!revokedAt || !Number.isFinite(Date.parse(revokedAt))) throw new Error("Unsubscribe revocation timestamp is invalid.");
  return { ...parseRecord(record), revokedAt };
}

function validateRecord(record: Omit<EmailUnsubscribeToken, "token">): void {
  normalizeEmail(record.email);
  if (!/^Patient\/[A-Za-z0-9.-]{1,64}$/.test(record.patientReference) || record.scope !== "marketing-promo" || !Number.isFinite(Date.parse(record.issuedAt))) {
    throw new Error("Unsubscribe record is invalid.");
  }
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Unsubscribe email is invalid.");
  return email;
}

function escapeSearch(value: string): string { return value.replace(/[\\|,$]/g, "\\$&"); }
function conditionalIdentifier(system: string, value: string): string { return new URLSearchParams({ identifier: `${system}|${escapeSearch(value)}` }).toString(); }
function validRouteToken(req: Request): boolean { return typeof req.params.token === "string" && TOKEN_RULE.test(req.params.token); }
function respond(res: Response, status: number, body: string): void {
  res.sendDate = false;
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
  res.status(status).type("html").send(body);
}
