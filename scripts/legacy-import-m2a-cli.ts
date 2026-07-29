export type M2aReferenceType =
  | "Patient"
  | "Practitioner"
  | "Encounter"
  | "Media"
  | "Coverage"
  | "Observation";

export function referenceId(reference: string, resourceType: M2aReferenceType): string {
  const match = reference.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]{1,64})$`));
  if (!match) throw new Error(`${resourceType} reference must be ${resourceType}/<id>.`);
  return match[1]!;
}

export function cliArgument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function ordinarySessionContext(
  request: typeof fetch,
  baseUrl: string,
  token: string,
  label: string,
  messages: {
    readonly responseStatus?: (status: number) => string;
    readonly missingProject?: string;
    readonly superAdmin?: string;
  } = {},
): Promise<{
  projectId: string;
  profileReference?: string;
}> {
  const response = await request(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    throw new Error(
      messages.responseStatus?.(response.status)
      ?? `${label} /auth/me expected 200; received ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    project?: { id?: string; superAdmin?: boolean };
    profile?: { resourceType?: string; id?: string; reference?: string };
    profileReference?: string;
  };
  if (!body.project?.id) {
    throw new Error(messages.missingProject ?? `${label} token has no active project.`);
  }
  if (body.project.superAdmin) {
    throw new Error(
      messages.superAdmin ?? `${label} token must be an ordinary practice login.`,
    );
  }
  const profileReference = body.profile?.reference
    ?? (body.profile?.resourceType && body.profile.id
      ? `${body.profile.resourceType}/${body.profile.id}`
      : undefined)
    ?? body.profileReference;
  return {
    projectId: body.project.id,
    ...(profileReference ? { profileReference } : {}),
  };
}
