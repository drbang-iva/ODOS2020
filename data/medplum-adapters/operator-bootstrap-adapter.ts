interface OperatorCredentials {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface ProjectMembershipShape {
  readonly resourceType?: string;
  readonly id?: string;
  readonly project?: { readonly reference?: string };
  readonly user?: { readonly reference?: string };
  readonly profile?: { readonly reference?: string };
  readonly admin?: boolean;
  readonly access?: readonly unknown[];
  readonly accessPolicy?: { readonly reference?: string };
}

export function createLiveOperatorIdentityAdapter(input: {
  readonly baseUrl: string;
  readonly serviceAccessToken?: string;
  readonly clientName: string;
}) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const serviceAccessToken = input.serviceAccessToken?.trim();
  const clientName = required(input.clientName, "operator client name");

  return {
    async create(projectId: string): Promise<{ clientId: string; clientSecret: string }> {
      const exactProjectId = required(projectId, "operator project id");
      const adminToken = required(serviceAccessToken, "Medplum service access token");
      const response = await fetch(
        `${baseUrl}/admin/projects/${encodeURIComponent(exactProjectId)}/client`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: clientName,
            description: "Local-only ODOS setup, repair, reseed, and integrity operator",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Operator ClientApplication create failed: ${response.status} ${response.statusText}`);
      }
      const created = (await response.json()) as { id?: string; secret?: string };
      return {
        clientId: required(created.id, "created operator client id"),
        clientSecret: required(created.secret, "created operator client secret"),
      };
    },

    async verify(credentials: OperatorCredentials): Promise<{ accessToken: string; membershipId: string }> {
      const accessToken = await exchangeOperatorCredential(baseUrl, credentials);
      const meResponse = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!meResponse.ok) {
        throw new Error(`Operator /auth/me verification failed: ${meResponse.status} ${meResponse.statusText}`);
      }
      const me = (await meResponse.json()) as {
        project?: { id?: string };
        membership?: ProjectMembershipShape;
        profile?: { resourceType?: string; id?: string; name?: string };
      };
      if (me.project?.id !== credentials.projectId) {
        throw new Error("Operator credential resolved to a different Medplum project.");
      }
      const membershipId = required(me.membership?.id, "operator membership id from /auth/me");
      const expectedProfile = `ClientApplication/${credentials.clientId}`;
      if (
        me.membership?.profile?.reference !== expectedProfile ||
        me.profile?.resourceType !== "ClientApplication" ||
        me.profile.id !== credentials.clientId ||
        me.profile.name !== clientName
      ) {
        throw new Error("Operator credential did not resolve to the named ClientApplication profile.");
      }

      const membershipResponse = await fetch(
        `${baseUrl}/fhir/R4/ProjectMembership/${encodeURIComponent(membershipId)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/fhir+json",
            "X-Medplum": "extended",
          },
        },
      );
      if (!membershipResponse.ok) {
        throw new Error(
          `Operator ProjectMembership verification failed: ${membershipResponse.status} ${membershipResponse.statusText}`,
        );
      }
      const membership = (await membershipResponse.json()) as ProjectMembershipShape;
      if (
        membership.id !== membershipId ||
        membership.project?.reference !== `Project/${credentials.projectId}` ||
        membership.user?.reference !== expectedProfile ||
        membership.profile?.reference !== expectedProfile ||
        membership.admin === true
      ) {
        throw new Error("Operator ProjectMembership does not match the exact non-admin client and project.");
      }
      if ((membership.access?.length ?? 0) !== 0 || membership.accessPolicy?.reference) {
        throw new Error("Operator ProjectMembership must have no access entries and no attached access policy.");
      }
      return { accessToken, membershipId };
    },

    async revoke(
      projectId: string,
      clientId: string,
      membershipId: string | undefined,
      credentials: OperatorCredentials,
    ): Promise<void> {
      const exactProjectId = required(projectId, "operator project id");
      const exactClientId = required(clientId, "operator client id");
      const exactMembershipId = required(membershipId, "operator membership id");
      const adminToken = required(serviceAccessToken, "Medplum service access token");
      if (
        credentials.projectId !== exactProjectId ||
        credentials.clientId !== exactClientId
      ) {
        throw new Error("Operator revocation credential does not match the exact client and project.");
      }
      await deleteExtendedResource(baseUrl, adminToken, "ProjectMembership", exactMembershipId);
      await deleteExtendedResource(baseUrl, adminToken, "ClientApplication", exactClientId);
      const tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: clientCredentialBody(credentials),
      });
      if (tokenResponse.ok) {
        throw new Error("Revoked operator client still obtained an access token.");
      }
    },
  };
}

async function exchangeOperatorCredential(baseUrl: string, credentials: OperatorCredentials): Promise<string> {
  const response = await fetch(`${baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: clientCredentialBody(credentials),
  });
  if (!response.ok) {
    throw new Error(`Operator client-credentials exchange failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { access_token?: string };
  return required(body.access_token, "operator access token");
}

function clientCredentialBody(credentials: OperatorCredentials): URLSearchParams {
  return new URLSearchParams({
    grant_type: "client_credentials",
    client_id: required(credentials.clientId, "operator client id"),
    client_secret: required(credentials.clientSecret, "operator client secret"),
  });
}

async function deleteExtendedResource(
  baseUrl: string,
  serviceAccessToken: string,
  resourceType: "ProjectMembership" | "ClientApplication",
  id: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/fhir/R4/${resourceType}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceAccessToken}`,
      Accept: "application/fhir+json",
      "X-Medplum": "extended",
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Operator ${resourceType} revocation failed: ${response.status} ${response.statusText}`);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
