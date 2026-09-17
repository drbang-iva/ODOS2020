import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createOperatorScriptFhirClient } from '../../mcp/src/fhir-client.js';

export async function createAuthenticatedFhirClient(input: { baseUrl: string; email: string; password: string }) {
  const verifier = randomBytes(32).toString('base64url');
  const login = await fetch(`${input.baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email, password: input.password, remember: false, codeChallengeMethod: 'S256', codeChallenge: createHash('sha256').update(verifier).digest('base64url') }),
  });
  assert.equal(login.status, 200, 'Synthetic login status');
  const authorization = await login.json() as { code?: string };
  assert.ok(authorization.code, 'Synthetic login authorization code');
  const response = await fetch(`${input.baseUrl}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: authorization.code, code_verifier: verifier }),
  });
  assert.equal(response.status, 200, 'Synthetic token exchange');
  const body = await response.json() as { access_token?: string };
  assert.ok(body.access_token);
  return { accessToken: body.access_token, fhir: createOperatorScriptFhirClient({ baseUrl: input.baseUrl, accessToken: body.access_token, reason: 'Disposable synthetic R10 served-route bootstrap outside request handling.' }) };
}
