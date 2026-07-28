export interface MigrationImporterClientResult {
  readonly clientId: string;
  readonly clientSecret: string;
}

export async function createMigrationImporterClient(input: {
  readonly baseUrl: string;
  readonly projectId: string;
  readonly accessToken: string;
  readonly accessPolicyReference: string;
  readonly name: string;
}): Promise<MigrationImporterClientResult> {
  const response = await fetch(
    `${input.baseUrl.replace(/\/$/, "")}/admin/projects/${input.projectId}/client`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        description: "ODOS local legacy migration importer",
        accessPolicy: { reference: input.accessPolicyReference },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Migration importer ClientApplication create failed: ${response.status} ${await response.text()}`,
    );
  }
  const created = (await response.json()) as { id?: string; secret?: string };
  if (!created.id || !created.secret) {
    throw new Error("Migration importer ClientApplication create returned no id or secret.");
  }
  return { clientId: created.id, clientSecret: created.secret };
}

export async function exchangeClientCredentials(input: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<string> {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Migration importer client-credentials exchange failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Migration importer client-credentials exchange returned no access_token.");
  }
  return body.access_token;
}
