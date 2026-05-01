# OSOD SMART Authorization Server

v0.55a adds the local SMART on FHIR v2 authorization server core to the OSOD MCP Node adapter. It runs only inside the practice-owned Docker Compose stack and composes with the v0.5a AccessPolicy / ProjectMembership substrate.

## Installation Prereqs

Generate a local SMART signing key with the existing OSOD certificate tooling:

```bash
osod certs generate --purpose smart-signing --out .osod/keys/smart-signing.pem
chmod 600 .osod/keys/smart-signing.pem
export OSOD_SMART_SIGNING_KEY_PATH="$PWD/.osod/keys/smart-signing.pem"
```

The private key path must be mode `0600`. The server never logs the private key. The public key is published from the local JWKS endpoint so local resource servers and confidential backend clients can validate issued tokens.

## Discovery

The SMART discovery document is served from:

```text
http://127.0.0.1:<mcp-port>/.well-known/smart-configuration
```

The document is generated dynamically from the local SMART server state on each request. It advertises only implemented capabilities and returns an ETag that changes when local SMART state changes, such as local app registration or signing-key publication changes.

## Dynamic App Registration

v0.55b registers opted-in SMART apps through RFC 7591 dynamic client registration at the local endpoint:

```bash
curl -X POST http://127.0.0.1:<mcp-port>/oauth2/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "Local SMART App",
    "redirect_uris": ["http://127.0.0.1:5173/callback"],
    "token_endpoint_auth_method": "none",
    "scope": "user/Observation.rs",
    "scope_request_canonical": "user/Observation.rs",
    "risk_class": "low",
    "phi_boundary": "metadata-only",
    "launch_mode": "ehr",
    "network_egress": "local-only",
    "external_services_required": false,
    "baa_required": false,
    "image_analysis_prohibited": true,
    "allowedJurisdictions": ["US"],
    "prohibitedStates": []
  }'
```

The registration stores an OSOD canonical Endpoint or Device record with the `smart-client-app` extension, then uses the Medplum adapter boundary to provision the local authorization client. The deprecated `/sandbox/register` endpoint returns HTTP 410 in v0.55b and is no longer advertised in SMART discovery.

## Confidential Asymmetric Backend Apps

Backend apps use `private_key_jwt` against the token endpoint. Generate the backend app keypair with `osod certs generate`, publish the app's local JWKS URL, then register the sandbox app with `client_type = "confidential"` and `jwks_uri`.

v0.55a also accepts confidential symmetric clients through Basic auth or POST body credentials for backward compatibility, but the asymmetric path is the canonical backend-app path.

## Scope Grammar

Ledger row 11 verifies the SMART resource-scope grammar used by the v0.55a preflight linter and authorization server:

```text
(patient|user|system)/<FHIR-resource-type>.<permissions>
```

v2 granular permissions are canonical: `c`, `r`, `u`, `d`, `s`. v1 forms such as `read` and `write` remain backward-compatible and are warned by Pass 4 lint.

## Staged Review

At authorization time OSOD intersects requested SMART scopes with the user's v0.5a AccessPolicy and ProjectMembership parameters. Low-risk reductions issue a token with reduced effective scope. High-risk differences enter staged admin review.

Only an authenticated `practice-admin` Practitioner can approve staged SMART scope decisions. Autonomous-agent approval attempts are rejected at the boundary layer and covered by the Mandate 8 test suite.
