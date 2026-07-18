import type {
  Organization,
  Practitioner,
  PractitionerRole,
  Resource,
  ServiceRequest,
} from "@medplum/fhirtypes";
import type { ReferralFhirClient } from "./referral-service.js";

export interface ReferralConsultant {
  reference: string;
  display: string;
}

export class ReferralDirectory {
  constructor(private readonly fhir: ReferralFhirClient) {}

  async search(query: string): Promise<ReferralConsultant[]> {
    const normalized = query.trim();
    if (normalized.length < 2) return [];

    const [practitioners, roles, organizations] = await Promise.all([
      this.fhir.search<Practitioner>("Practitioner", {
        "name:contains": normalized,
        _count: "20",
      }),
      this.fhir.search<PractitionerRole>("PractitionerRole", {
        "practitioner.name:contains": normalized,
        _count: "20",
      }),
      this.fhir.search<Organization>("Organization", {
        "name:contains": normalized,
        _count: "20",
      }),
    ]);
    return distinctConsultants([
      ...resources(practitioners).map(practitionerConsultant),
      ...resources(roles).map(practitionerRoleConsultant),
      ...resources(organizations).map(organizationConsultant),
    ]).slice(0, 20);
  }

  async recent(staffReference: string): Promise<ReferralConsultant[]> {
    const bundle = await this.fhir.search<ServiceRequest>("ServiceRequest", {
      requester: staffReference,
      _sort: "-authored",
      _count: "20",
    });
    const ordered = resources(bundle)
      .filter((referral) => referral.requester?.reference === staffReference)
      .sort((left, right) => (right.authoredOn ?? "").localeCompare(left.authoredOn ?? ""))
      .flatMap((referral) => {
        const target = referral.performer?.[0];
        return target?.reference && target.display?.trim()
          ? [{ reference: target.reference, display: target.display.trim() }]
          : [];
      });
    return distinctConsultants(ordered).slice(0, 5);
  }
}

function practitionerConsultant(practitioner: Practitioner): ReferralConsultant {
  return {
    reference: resourceReference(practitioner),
    display: humanName(practitioner.name?.find((name) => name.use === "official") ?? practitioner.name?.[0])
      || resourceReference(practitioner),
  };
}

function practitionerRoleConsultant(role: PractitionerRole): ReferralConsultant {
  return {
    reference: resourceReference(role),
    display: role.practitioner?.display?.trim()
      || role.organization?.display?.trim()
      || role.code?.[0]?.text?.trim()
      || role.code?.[0]?.coding?.find((coding) => coding.display?.trim())?.display?.trim()
      || role.specialty?.[0]?.text?.trim()
      || resourceReference(role),
  };
}

function organizationConsultant(organization: Organization): ReferralConsultant {
  return {
    reference: resourceReference(organization),
    display: organization.name?.trim() || resourceReference(organization),
  };
}

function distinctConsultants(consultants: ReferralConsultant[]): ReferralConsultant[] {
  const seen = new Set<string>();
  return consultants.filter((consultant) => {
    if (seen.has(consultant.reference)) return false;
    seen.add(consultant.reference);
    return true;
  });
}

function resources<T extends Resource>(bundle: { entry?: Array<{ resource?: T }> }): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function resourceReference(resource: Resource): string {
  if (!resource.id) throw new Error(`${resource.resourceType} directory result is missing an id.`);
  return `${resource.resourceType}/${resource.id}`;
}

function humanName(name: { text?: string; given?: string[]; family?: string } | undefined): string {
  if (name?.text?.trim()) return name.text.trim();
  return [...(name?.given ?? []), name?.family].filter(Boolean).join(" ").trim();
}
