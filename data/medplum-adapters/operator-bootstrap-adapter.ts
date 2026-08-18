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
  readonly verifyMembership: (input: {
    readonly projectId: string;
    readonly clientId: string;
    readonly membershipId: string;
  }) => Promise<void>;
  readonly resolveMembership: (input: {
    readonly projectId: string;
    readonly clientId: string;
  }) => Promise<string>;
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

      try {
        await input.verifyMembership({
          projectId: credentials.projectId,
          clientId: credentials.clientId,
          membershipId,
        });
      } catch (error) {
        throw Object.assign(
          new Error(error instanceof Error ? error.message : String(error), { cause: error }),
          { membershipId },
        );
      }
      return { accessToken, membershipId };
    },

    async resolveMembership(projectId: string, clientId: string): Promise<string> {
      return input.resolveMembership({
        projectId: required(projectId, "operator project id"),
        clientId: required(clientId, "operator client id"),
      });
    },

    async clientExists(projectId: string, clientId: string): Promise<boolean> {
      required(projectId, "operator project id");
      const exactClientId = required(clientId, "operator client id");
      const adminToken = required(serviceAccessToken, "Medplum service access token");
      const response = await fetch(
        `${baseUrl}/fhir/R4/ClientApplication/${encodeURIComponent(exactClientId)}`,
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
            Accept: "application/fhir+json",
            "X-Medplum": "extended",
          },
        },
      );
      if (response.ok) return true;
      if (response.status === 404 || response.status === 410) return false;
      throw new Error(`Operator ClientApplication existence check failed: ${response.status} ${response.statusText}`);
    },

    async revoke(
      projectId: string,
      clientId: string,
      membershipId: string | undefined,
      credentials?: OperatorCredentials,
    ): Promise<void> {
      const exactProjectId = required(projectId, "operator project id");
      const exactClientId = required(clientId, "operator client id");
      const adminToken = required(serviceAccessToken, "Medplum service access token");
      if (credentials && (
        credentials.projectId !== exactProjectId ||
        credentials.clientId !== exactClientId
      )) {
        throw new Error("Operator revocation credential does not match the exact client and project.");
      }
      const deletionErrors: Error[] = [];
      if (membershipId) {
        try {
          await deleteExtendedResource(
            baseUrl,
            adminToken,
            "ProjectMembership",
            required(membershipId, "operator membership id"),
          );
        } catch (error) {
          deletionErrors.push(asError(error));
        }
      }
      try {
        await deleteExtendedResource(baseUrl, adminToken, "ClientApplication", exactClientId);
      } catch (error) {
        deletionErrors.push(asError(error));
      }
      if (deletionErrors.length > 0) {
        throw new AggregateError(deletionErrors, `Operator revocation failed: ${deletionErrors.map((error) => error.message).join("; ")}`);
      }
      if (credentials) {
        const tokenResponse = await fetch(`${baseUrl}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: clientCredentialBody(credentials),
        });
        if (tokenResponse.ok) {
          throw new Error("Revoked operator client still obtained an access token.");
        }
      } else {
        const response = await fetch(
          `${baseUrl}/fhir/R4/ClientApplication/${encodeURIComponent(exactClientId)}`,
          {
            headers: {
              Authorization: `Bearer ${adminToken}`,
              Accept: "application/fhir+json",
              "X-Medplum": "extended",
            },
          },
        );
        if (response.ok) throw new Error("Revoked operator ClientApplication still exists.");
        if (response.status !== 404 && response.status !== 410) {
          throw new Error(`Operator ClientApplication revocation proof failed: ${response.status} ${response.statusText}`);
        }
      }
    },
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
