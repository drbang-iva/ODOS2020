import { randomBytes } from "node:crypto";
import type { Application, Request, Response } from "express";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";

const TRACKED_LINK_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/tracked-link-token";
const TRACKED_LINK_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-resource-kind";
const TARGET_URL = "https://odos2020.com/fhir/StructureDefinition/tracked-link-target-url";
const CAMPAIGN_ID = "https://odos2020.com/fhir/StructureDefinition/tracked-link-campaign-id";
const MESSAGE_ID = "https://odos2020.com/fhir/StructureDefinition/tracked-link-message-id";
const CLICKED_AT = "https://odos2020.com/fhir/StructureDefinition/tracked-link-clicked-at";
const LINK_REFERENCE = "https://odos2020.com/fhir/StructureDefinition/tracked-link-reference";

export interface TrackedLink {
  token: string;
  targetUrl: string;
  campaignId: string;
  messageId: string;
  createdAt: string;
}

export interface TrackedLinkClick {
  token: string;
  campaignId: string;
  messageId: string;
  clickedAt: string;
}

export interface TrackedLinkStore {
  create(link: TrackedLink): Promise<void>;
  find(token: string): Promise<TrackedLink | undefined>;
  logClick(click: TrackedLinkClick): Promise<void>;
}

export interface TrackedLinkRouteDeps {
  store: TrackedLinkStore;
  now?: () => string;
  authenticateService?: () => Promise<void>;
}

export async function generateTrackedLink(input: {
  store: TrackedLinkStore;
  publicBaseUrl: string;
  targetUrl: string;
  campaignId: string;
  messageId: string;
  generateToken?: () => string;
  now?: () => string;
}): Promise<{ token: string; url: string }> {
  const publicBaseUrl = httpsUrl(input.publicBaseUrl, "Tracked-link public base URL");
  const targetUrl = httpsUrl(input.targetUrl, "Tracked-link destination URL");
  const campaignId = required(input.campaignId, "Tracked-link campaign id");
  const messageId = required(input.messageId, "Tracked-link message id");
  const token = input.generateToken?.() ?? randomBytes(18).toString("base64url");
  assertToken(token);
  await input.store.create({
    token,
    targetUrl,
    campaignId,
    messageId,
    createdAt: input.now?.() ?? new Date().toISOString(),
  });
  return { token, url: `${publicBaseUrl}/comms/r/${token}` };
}

export function registerTrackedLinkRoutes(
  app: Pick<Application, "get">,
  deps: TrackedLinkRouteDeps,
): void {
  app.get("/comms/r/:token", async (req: Request, res: Response) => {
    try {
      await deps.authenticateService?.();
      const token = routeParam(req.params.token);
      assertToken(token);
      const link = await deps.store.find(token);
      if (!link) {
        res.status(404).send("Tracked link not found.");
        return;
      }
      await deps.store.logClick({
        token,
        campaignId: link.campaignId,
        messageId: link.messageId,
        clickedAt: deps.now?.() ?? new Date().toISOString(),
      });
      res.redirect(302, link.targetUrl);
    } catch (error) {
      console.error("odos-mcp: tracked-link redirect failed:", error);
      if (!res.headersSent) res.status(400).send("Tracked link is invalid.");
    }
  });
}

export function createInMemoryTrackedLinkStore(): TrackedLinkStore & {
  clicks(): TrackedLinkClick[];
} {
  const links = new Map<string, TrackedLink>();
  const clickRows: TrackedLinkClick[] = [];
  return {
    async create(link) {
      if (links.has(link.token)) throw new Error("Tracked-link token already exists.");
      links.set(link.token, structuredClone(link));
    },
    async find(token) {
      const link = links.get(token);
      return link ? structuredClone(link) : undefined;
    },
    async logClick(click) {
      clickRows.push(structuredClone(click));
    },
    clicks() {
      return structuredClone(clickRows);
    },
  };
}

export type TrackedLinkFhir = Pick<MedplumClient, "search" | "create">;

export function createFhirTrackedLinkStore(fhir: TrackedLinkFhir): TrackedLinkStore {
  return {
    async create(link) {
      await fhir.create<Basic>(linkResource(link), {
        "If-None-Exist": `identifier=${TRACKED_LINK_IDENTIFIER_SYSTEM}|${link.token}`,
      });
    },
    async find(token) {
      const bundle = await fhir.search<Basic>("Basic", {
        identifier: `${TRACKED_LINK_IDENTIFIER_SYSTEM}|${token}`,
        _count: "2",
      });
      const matches = resources(bundle).filter((resource) =>
        resource.code.coding?.some((coding) =>
          coding.system === TRACKED_LINK_CODE_SYSTEM && coding.code === "tracked-link"));
      if (matches.length > 1) throw new Error("Tracked-link token is not unique.");
      return matches[0] ? parseLink(matches[0]) : undefined;
    },
    async logClick(click) {
      await fhir.create<Basic>({
        resourceType: "Basic",
        code: {
          coding: [{
            system: TRACKED_LINK_CODE_SYSTEM,
            code: "tracked-link-click",
            display: "Tracked link click",
          }],
        },
        extension: [
          { url: LINK_REFERENCE, valueString: click.token },
          { url: CAMPAIGN_ID, valueString: click.campaignId },
          { url: MESSAGE_ID, valueString: click.messageId },
          { url: CLICKED_AT, valueInstant: click.clickedAt },
        ],
      });
    },
  };
}

function linkResource(link: TrackedLink): Basic {
  return {
    resourceType: "Basic",
    identifier: [{ system: TRACKED_LINK_IDENTIFIER_SYSTEM, value: link.token }],
    code: {
      coding: [{
        system: TRACKED_LINK_CODE_SYSTEM,
        code: "tracked-link",
        display: "Tracked link",
      }],
    },
    created: link.createdAt.slice(0, 10),
    extension: [
      { url: TARGET_URL, valueUrl: link.targetUrl },
      { url: CAMPAIGN_ID, valueString: link.campaignId },
      { url: MESSAGE_ID, valueString: link.messageId },
    ],
  };
}

function parseLink(resource: Basic): TrackedLink {
  const token = resource.identifier?.find(
    (identifier) => identifier.system === TRACKED_LINK_IDENTIFIER_SYSTEM,
  )?.value;
  const targetUrl = extensionValue(resource, TARGET_URL, "valueUrl");
  const campaignId = extensionValue(resource, CAMPAIGN_ID, "valueString");
  const messageId = extensionValue(resource, MESSAGE_ID, "valueString");
  const createdAt = resource.meta?.lastUpdated ?? resource.created ?? "";
  assertToken(token ?? "");
  return {
    token: token!,
    targetUrl: httpsUrl(targetUrl, "Stored tracked-link destination"),
    campaignId: required(campaignId, "Stored tracked-link campaign id"),
    messageId: required(messageId, "Stored tracked-link message id"),
    createdAt: required(createdAt, "Stored tracked-link created timestamp"),
  };
}

function extensionValue(
  resource: Basic,
  url: string,
  field: "valueUrl" | "valueString" | "valueInstant",
): string {
  const extension = resource.extension?.find((entry) => entry.url === url);
  const value = extension?.[field];
  return typeof value === "string" ? value : "";
}

function resources(bundle: Bundle<Basic>): Basic[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function assertToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("Tracked-link token is invalid.");
  }
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function httpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must use HTTPS.`);
  }
  return value.replace(/\/$/, "");
}
