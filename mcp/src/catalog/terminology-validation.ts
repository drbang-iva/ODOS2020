export interface LocalTerminologyLookup {
  readonly hasHcpcsCode: (code: string) => boolean | Promise<boolean>;
  readonly hasSnomedCode: (code: string) => boolean | Promise<boolean>;
}

const EXTERNAL_TERMINOLOGY_HOSTS = [
  "tx.fhir.org",
  "terminology.hl7.org",
  "uts.nlm.nih.gov",
  "uts-ws.nlm.nih.gov",
];

export function assertLocalTerminologyUrl(url: string): void {
  const host = new URL(url).host.toLowerCase();
  if (EXTERNAL_TERMINOLOGY_HOSTS.some((forbidden) => host === forbidden || host.endsWith(`.${forbidden}`))) {
    throw new Error(`local terminology validation only: external terminology host blocked (${host})`);
  }
}

export async function validateFrameTerminologyLocally(
  lookup: LocalTerminologyLookup,
): Promise<void> {
  for (const code of ["V2020", "V2025", "V2600"]) {
    if (!(await lookup.hasHcpcsCode(code))) {
      throw new Error(`local terminology validation failed: missing HCPCS ${code}`);
    }
  }
  if (!(await lookup.hasSnomedCode("310105000"))) {
    throw new Error("local terminology validation failed: missing SNOMED CT 310105000");
  }
}
