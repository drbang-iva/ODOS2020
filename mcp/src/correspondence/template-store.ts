import { randomUUID } from "node:crypto";
import type { Basic } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { searchAll } from "../fhir-search.js";
import { validateCorrespondenceTemplateTokens } from "./tokens/registry.js";

export const CORRESPONDENCE_TEMPLATE_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/basic-kind";
export const CORRESPONDENCE_TEMPLATE_CODE = "correspondence-template";
export const CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/correspondence-template";
export const CORRESPONDENCE_TEMPLATE_WRITE_HEADERS = {
  "X-ODOS-Source": "mcp/correspondence-template",
} as const;

export type CorrespondenceLetterType =
  | "referral"
  | "consult-report"
  | "progress"
  | "records-transfer"
  | "general"
  | (string & {});
export type CorrespondenceRegister = "formal" | "warm";

export interface CorrespondenceTemplateInput {
  name: string;
  letterType: CorrespondenceLetterType;
  specialty: string;
  bodyHtml: string;
  register: CorrespondenceRegister;
}

export interface CorrespondenceTemplate extends CorrespondenceTemplateInput {
  id: string;
  active: boolean;
  curated: boolean;
}

export const CURATED_REFERRAL_TEMPLATES: readonly CorrespondenceTemplateInput[] = [
  {
    name: "General ophthalmology referral",
    letterType: "referral",
    specialty: "ophthalmology",
    register: "formal",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>I am referring {{patient.name}} for your evaluation and management.</p>{{findings.block}}{{plan.block}}{{meds.list}}{{allergies.list}}<p>Sincerely,<br>{{sender.name}}, {{sender.credentials}}</p>",
  },
  {
    name: "Glaucoma referral",
    letterType: "referral",
    specialty: "glaucoma",
    register: "formal",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>Please evaluate {{patient.name}} for glaucoma-related care.</p>{{va.table}}{{iop.table}}{{vf.summary}}{{findings.block}}{{plan.block}}<p>Sincerely,<br>{{sender.name}}, {{sender.credentials}}</p>",
  },
  {
    name: "Retina referral",
    letterType: "referral",
    specialty: "retina",
    register: "warm",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>Thank you for seeing {{patient.name}} for retinal evaluation.</p>{{va.table}}{{refraction.table}}{{findings.block}}{{plan.block}}<p>With appreciation,<br>{{sender.name}}, {{sender.credentials}}</p>",
  },
] as const;

export const CURATED_CONSULT_REPORT_TEMPLATES: readonly CorrespondenceTemplateInput[] = [
  {
    name: "Formal consult report",
    letterType: "consult-report",
    specialty: "general",
    register: "formal",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>Thank you for asking me to evaluate {{patient.name}}.</p><h2>Question addressed</h2><p>{{consult.question}}</p>{{findings.block}}{{plan.block}}{{meds.list}}{{allergies.list}}",
  },
  {
    name: "Warm thank-you with findings",
    letterType: "consult-report",
    specialty: "general",
    register: "warm",
    bodyHtml: "<p>Dear {{recipient.name}},</p><p>Thank you for referring {{patient.name}}. I appreciate the opportunity to participate in their care.</p><h2>Your question</h2><p>{{consult.question}}</p>{{findings.block}}{{plan.block}}<p>I will keep you informed of meaningful changes.</p>",
  },
] as const;

type TemplateFhirClient = Pick<
  MedplumClient,
  "baseUrl" | "search" | "searchUrl" | "create" | "update"
>;

export class CorrespondenceTemplateStore {
  constructor(
    private readonly fhir: TemplateFhirClient,
    private readonly createId: () => string = randomUUID,
  ) {}

  async list(letterType?: string): Promise<CorrespondenceTemplate[]> {
    await this.seedCurated();
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${CORRESPONDENCE_TEMPLATE_CODE_SYSTEM}|${CORRESPONDENCE_TEMPLATE_CODE}`,
      _count: "200",
    });
    return resources
      .filter(isCorrespondenceTemplateBasic)
      .map(parseCorrespondenceTemplate)
      .filter((template) => template.active && (!letterType || template.letterType === letterType))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async read(id: string): Promise<CorrespondenceTemplate | undefined> {
    assertTemplateId(id);
    return (await this.list()).find((template) => template.id === id);
  }

  async create(input: CorrespondenceTemplateInput): Promise<CorrespondenceTemplate> {
    const id = this.createId();
    assertTemplateId(id);
    validateTemplateInput(input);
    const created = await this.fhir.create(
      buildCorrespondenceTemplateResource({ id, ...input, active: true, curated: false }),
      {
        ...CORRESPONDENCE_TEMPLATE_WRITE_HEADERS,
        "If-None-Exist": `identifier=${CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM}|${id}`,
      },
    );
    return parseCorrespondenceTemplate(created);
  }

  async update(id: string, input: CorrespondenceTemplateInput): Promise<CorrespondenceTemplate> {
    assertTemplateId(id);
    validateTemplateInput(input);
    const existing = await this.readResource(id);
    if (!existing?.id) throw new Error("Correspondence template was not found.");
    const parsed = parseCorrespondenceTemplate(existing);
    const updated = await this.fhir.update(
      "Basic",
      existing.id,
      buildCorrespondenceTemplateResource({
        id,
        ...input,
        active: true,
        curated: parsed.curated,
      }, existing),
      CORRESPONDENCE_TEMPLATE_WRITE_HEADERS,
    );
    return parseCorrespondenceTemplate(updated);
  }

  async remove(id: string): Promise<void> {
    assertTemplateId(id);
    const existing = await this.readResource(id);
    if (!existing?.id) return;
    const parsed = parseCorrespondenceTemplate(existing);
    await this.fhir.update(
      "Basic",
      existing.id,
      buildCorrespondenceTemplateResource({ ...parsed, active: false }, existing),
      CORRESPONDENCE_TEMPLATE_WRITE_HEADERS,
    );
  }

  private async seedCurated(): Promise<void> {
    const templates = [
      ...CURATED_REFERRAL_TEMPLATES.map((template, index) => ({
        id: `starter-referral-${index + 1}`,
        template,
      })),
      ...CURATED_CONSULT_REPORT_TEMPLATES.map((template, index) => ({
        id: `starter-consult-report-${index + 1}`,
        template,
      })),
    ];
    for (const { id, template } of templates) {
      await this.fhir.create(
        buildCorrespondenceTemplateResource({
          id,
          ...template,
          active: true,
          curated: true,
        }),
        {
          ...CORRESPONDENCE_TEMPLATE_WRITE_HEADERS,
          "If-None-Exist": `identifier=${CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM}|${id}`,
        },
      );
    }
  }

  private async readResource(id: string): Promise<Basic | undefined> {
    const resources = await searchAll<Basic>(this.fhir, "Basic", {
      code: `${CORRESPONDENCE_TEMPLATE_CODE_SYSTEM}|${CORRESPONDENCE_TEMPLATE_CODE}`,
      identifier: `${CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM}|${id}`,
      _count: "2",
    });
    return resources.find((resource) =>
      resource.identifier?.some((identifier) =>
        identifier.system === CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM
        && identifier.value === id));
  }
}

export function buildCorrespondenceTemplateResource(
  template: CorrespondenceTemplate,
  existing?: Basic,
): Basic {
  validateTemplateInput(template);
  assertTemplateId(template.id);
  return {
    resourceType: "Basic",
    ...(existing?.id ? { id: existing.id } : {}),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [{ system: CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM, value: template.id }],
    code: {
      coding: [{
        system: CORRESPONDENCE_TEMPLATE_CODE_SYSTEM,
        code: CORRESPONDENCE_TEMPLATE_CODE,
        display: "Correspondence template",
      }],
      text: CORRESPONDENCE_TEMPLATE_CODE,
    },
    extension: [
      { url: "name", valueString: template.name.trim() },
      { url: "letter-type", valueCode: template.letterType },
      { url: "specialty", valueString: template.specialty.trim() },
      { url: "body-html", valueString: template.bodyHtml },
      { url: "register", valueCode: template.register },
      { url: "active", valueBoolean: template.active },
      { url: "curated", valueBoolean: template.curated },
    ],
  };
}

export function parseCorrespondenceTemplate(resource: Basic): CorrespondenceTemplate {
  if (!isCorrespondenceTemplateBasic(resource)) {
    throw new Error("Basic resource is not a correspondence template.");
  }
  const id = resource.identifier?.find(
    (identifier) => identifier.system === CORRESPONDENCE_TEMPLATE_IDENTIFIER_SYSTEM,
  )?.value;
  if (!id) throw new Error("Correspondence template identifier is missing.");
  const template: CorrespondenceTemplate = {
    id,
    name: requiredString(resource, "name"),
    letterType: requiredCode(resource, "letter-type"),
    specialty: requiredString(resource, "specialty"),
    bodyHtml: requiredString(resource, "body-html"),
    register: requiredRegister(resource),
    active: resource.extension?.find((extension) => extension.url === "active")?.valueBoolean ?? true,
    curated: resource.extension?.find((extension) => extension.url === "curated")?.valueBoolean ?? false,
  };
  validateTemplateInput(template);
  return template;
}

function isCorrespondenceTemplateBasic(resource: Basic): boolean {
  return Boolean(resource.code?.coding?.some((coding) =>
    coding.system === CORRESPONDENCE_TEMPLATE_CODE_SYSTEM
    && coding.code === CORRESPONDENCE_TEMPLATE_CODE));
}

function validateTemplateInput(input: CorrespondenceTemplateInput): void {
  if (!input.name.trim()) throw new Error("Correspondence template name is required.");
  if (!input.letterType.trim()) throw new Error("Correspondence letter type is required.");
  if (!input.specialty.trim()) throw new Error("Correspondence specialty is required.");
  if (!input.bodyHtml.trim()) throw new Error("Correspondence template body is required.");
  if (input.register !== "formal" && input.register !== "warm") {
    throw new Error("Correspondence register must be formal or warm.");
  }
  validateCorrespondenceTemplateTokens(input.bodyHtml);
}

function assertTemplateId(value: string): void {
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(value)) {
    throw new Error("A valid correspondence template id is required.");
  }
}

function requiredString(resource: Basic, url: string): string {
  const value = resource.extension?.find((extension) => extension.url === url)?.valueString;
  if (!value?.trim()) throw new Error(`Correspondence template ${url} is missing.`);
  return value;
}

function requiredCode(resource: Basic, url: string): string {
  const value = resource.extension?.find((extension) => extension.url === url)?.valueCode;
  if (!value?.trim()) throw new Error(`Correspondence template ${url} is missing.`);
  return value;
}

function requiredRegister(resource: Basic): CorrespondenceRegister {
  const value = requiredCode(resource, "register");
  if (value !== "formal" && value !== "warm") {
    throw new Error("Correspondence template register is invalid.");
  }
  return value;
}
