# ODOS Practice Install

Run ODOS on your own hardware. Your patients, your machines, your data.

This is the v0.5d local-hardware install path from the production-spine build sheet. The canonical deployment unit is the root `docker-compose.yml`; v0.5d adds the setup wizard, backup-destination verifier, and provider-agnostic local preflight linter around that stack.

## Hardware

Use practice-owned hardware: Mac Studio, NUC, Linux box, or server. Minimum practical target:

- 16 GB RAM or more.
- 500 GB storage or more.
- Local or attached-drive backup destination.
- Physical access, device inventory, media handling, and facility safeguards owned by the practice.

Ledger row 46 verifies HIPAA 45 CFR §164.310 physical safeguards. ODOS documents and assists, but the practice is the responsible actor for the machine and backup media.

## Install Docker Compose v2

Install Docker with Compose v2 from Docker's official documentation:

<https://docs.docker.com/compose/install/>

Ledger row 47 verifies that Compose v2 uses `docker compose` and the Compose Specification. If your install exposes the standalone `docker-compose` binary instead, use the equivalent `docker-compose` command; the root npm scripts follow the binary available in this local development environment.

## Start the Local Stack

Create `.env` from `.env.example` and fill in the required values before starting
Compose. Set `MEDPLUM_DATABASE_PASSWORD` to a unique database password and
`ODOS_POSTGRES_URL` to the matching connection string described below. Also set
`ODOS_REDIS_PASSWORD` to a unique Redis password. Compose
refuses to start the main stack when the database password is missing or empty.

```bash
git clone https://github.com/drbang-iva/ODOS2020.git
cd ODOS2020
cp .env.example .env
chmod 600 .env
# Fill in .env before continuing. Do not overwrite an existing installation's .env.
npm install
cd mcp && npm install && cd ..
cd ui && npm install && cd ..
npm run generate-medplum-signing-keys
docker-compose up -d
docker-compose ps
```

The root `docker-compose.yml` starts Postgres, Redis, Medplum server, and the local Medplum admin UI. ODOS setup and preflight commands run from the repo against that local stack.
Run `npm install` in `mcp/` after pulling changes as well as during first install.
Its dependencies are separate from the root package; stale `mcp/node_modules` can
otherwise surface only at backend start as an `ERR_MODULE_NOT_FOUND` crash loop
(for example, when `csv-parse` is first imported by a newly pulled job).

### Alpine-native MCP dependencies

The MCP package includes Sharp, a native image-processing dependency. Host-installed
`mcp/node_modules` is not portable into the `node:22-alpine` ODOS Core runtime:
macOS and glibc Linux installs do not contain the musl binary Alpine needs. Compose
therefore runs `npm ci --omit=dev --include=optional --no-audit --no-fund` inside
Alpine through `odos-core-deps` and stores the result in the
`odos-mcp-node-modules` volume mounted read-only by `odos-core`.

After cloning, pulling a changed `mcp/package-lock.json`, or moving an install to
different hardware, run the installer explicitly before starting the AgentOps
profile:

```bash
docker-compose --profile agentops run --rm odos-core-deps
docker-compose --profile agentops up -d
```

The static Sharp import is evaluated during ODOS Core startup, so a missing or
incompatible native binary stops the service immediately with Sharp's platform
diagnostic rather than waiting for a provider signature upload.

The signing-key generator writes independent main and DR-drill RSA keys to ignored,
mode-0600 files under `.odos/`. Medplum 5.1.8 loads the tracked JSON first and then
overlays `MEDPLUM_SIGNING_KEY`, `MEDPLUM_SIGNING_KEY_ID`, and
`MEDPLUM_SIGNING_KEY_PASSPHRASE` from those files. The tracked values are inert.
For an intentional rotation, run `npm run generate-medplum-signing-keys -- --force`
and restart the applicable Medplum server. Rotation expires outstanding one-hour
storage URLs; it does not change stored Binary data.
If you remap the storage port or serve storage from another host, set
`MEDPLUM_STORAGE_BASE_URL` to that public storage origin; otherwise attachment
fetches fail with HTTP 401 `Invalid signature` and no server-log breadcrumb.

### Database password configuration

The main stack reads `MEDPLUM_DATABASE_PASSWORD` from the untracked `.env` and
passes it to both PostgreSQL initialization and the Medplum server. Medplum loads
`file:/config/medplum.config.json,env`, so the environment overrides the inert JSON
password while retaining the JSON database host, port, and other settings.
Never place the real password in tracked Compose or JSON files.

Set `ODOS_POSTGRES_URL` separately for the ODOS service and operator scripts, using
`postgresql://medplum:<encoded-password>@127.0.0.1:5433/medplum`. Percent-encode the
password component of that URL; do not encode the separate
`MEDPLUM_DATABASE_PASSWORD` value. Single-quote values containing `$` or `#` in
`.env` so Compose reads them literally; escape an embedded apostrophe as `\'`.
The two settings must describe the same
database account. The optional containerized `odos-core` uses the internal host
`postgres:5432` with a password-free URL and receives the same raw password through
`PGPASSWORD`; node-postgres uses that environment value when the URL omits a password.
The isolated DR-drill stack retains its own disposable defaults
and does not consume the main stack's password.

For an existing installation, first configure the current database password in
the untracked environment and recreate Medplum with the new environment wiring.
Coordinate automatic source updates and service restarts during this rollout:
an old container does not acquire a newly added environment variable on restart.
Verify this configuration migration before changing the database role password.
Changing `POSTGRES_PASSWORD` or `.env` does not alter a role in an existing
PostgreSQL volume. Perform that later rotation in an authorized maintenance
window, update both environment settings, recreate affected containers, restart
the ODOS service, and verify database-backed operations. Never delete the database
volume to apply a password change or print resolved Compose configuration with
real credentials into logs or public evidence.

### Redis password configuration

The main stack requires `ODOS_REDIS_PASSWORD` in the ignored `.env`. Compose uses
that same raw value in the Redis server command, its healthcheck, and Medplum's
`MEDPLUM_REDIS_PASSWORD` environment override. The tracked JSON Redis password is
an inert placeholder; the existing `file:/config/medplum.config.json,env` loader
replaces it at runtime. The healthcheck uses `redis-cli -e` so authentication
errors produce a failing exit status. Use the single-quote escaping guidance above for special
characters. Never put the replacement password in tracked configuration.

Before deploying this configuration, the ignored `.env` must contain
`ODOS_REDIS_PASSWORD`, `MEDPLUM_DATABASE_PASSWORD`, and the matching
`ODOS_POSTGRES_URL`, along with the existing bootstrap and signing configuration.
Stage the current Redis password first, recreate the affected services with the
environment wiring, and verify operation before the separate operator rotation.
Missing or empty Redis/PostgreSQL passwords prevent Compose from rendering.
Recreating Redis may drop cache and session state and log users out. The Redis
image declares `/data` as a volume; do not assume there is no persisted Redis data.
Coordinate recreation and rotation in an operator-selected maintenance window.

Host-run `scripts/backup.sh` and `scripts/restore.sh` require exported
`ODOS_POSTGRES_URL` and `ODOS_REDIS_PASSWORD`; merely editing `.env` does not export
those variables into a shell. Both scripts refuse missing or empty values by name
before backup/restore operations. The isolated drill wrapper supplies its own Redis
credential regardless of the persistent password exported in the calling shell.
See `docs/dr-drill.md` for the manual drill environment.

The root npm scripts use `docker-compose` in this checkout. If your Docker install exposes only `docker compose`, use the equivalent space-separated command.

Healthcheck commands:

```bash
curl -fsS http://localhost:8103/healthcheck
docker-compose ps
docker-compose logs --tail 100 medplum-server
```

Expected local endpoints:

| Service | URL |
|---|---|
| FHIR API | `http://localhost:8103/fhir/R4` — loopback-only by design (INGRESS-0) |
| Medplum admin UI | `http://localhost:8100` — loopback-only by design (INGRESS-0) |
| Postgres | `127.0.0.1:5433` |
| Redis | `127.0.0.1:6379` |

## Environment Variables

Create `.env` from `.env.example` or export these variables in the shell that runs the setup wizard.

| Variable | Required | Purpose |
|---|---:|---|
| `ODOS_PRACTICE_NAME` | yes | Practice/project name for first-run provisioning. |
| `ODOS_ADMIN_EMAIL` | yes | Human-owned admin email; it must be distinct from the `MEDPLUM_ADMIN_EMAIL` break-glass account. |
| `ODOS_ADMIN_NAME` | yes | First admin/practitioner display name. |
| `ODOS_ADMIN_PASSWORD` | yes | Human-owned Medplum password. `MEDPLUM_ADMIN_PASSWORD` is also accepted as a fallback for this value; keep the human password separate from the MCP break-glass secret. |
| `MEDPLUM_BASE_URL` | no | Defaults to `http://localhost:8103`. |
| `MEDPLUM_PROJECT_ID` | no | Compatibility fallback when installation state is absent. When set, it must equal the canonical project ID in `.odos-setup-state.json`. |
| `MEDPLUM_CLIENT_ID` | no | ClientApplication ID for the scoped MCP service identity. Set it only together with `MEDPLUM_CLIENT_SECRET`. |
| `MEDPLUM_CLIENT_SECRET` | no | Secret for the scoped MCP service identity. When both `MEDPLUM_CLIENT_*` values are set, MCP startup and token refresh use `client_credentials` and fail closed on partial configuration or exchange failure. |
| `MEDPLUM_ADMIN_EMAIL` | yes for first-run setup and local Compose | Medplum super-admin bootstrap email and break-glass MCP password-login email. The MCP runtime uses it only when both `MEDPLUM_CLIENT_*` values are absent. |
| `MEDPLUM_ADMIN_PASSWORD` | yes for first-run setup and local Compose | Medplum super-admin bootstrap secret and break-glass MCP password-login secret. It never recovers a partial, invalid, or failed client-credential configuration. |
| `MEDPLUM_STORAGE_BASE_URL` | no | Defaults to `http://localhost:8103/storage/`; set it to the public storage origin when the port or host is remapped. |
| `ODOS_REDIS_PASSWORD` | yes for the main Compose stack and host backup/restore | Raw Redis password; Medplum receives it through its Redis environment override. The isolated drill uses its own credential. |
| `MEDPLUM_DATABASE_PASSWORD` | yes for the main Compose stack | Untracked runtime password shared by PostgreSQL initialization and the Medplum environment override. Does not rotate an existing database role. |
| `ODOS_POSTGRES_URL` | yes for a configured installation | PostgreSQL URL used by ODOS and operator scripts; use the same password as Medplum, URL-encoded. |
| `ODOS_SETUP_STATE_PATH` | no | Defaults to `./.odos-setup-state.json`. No PHI is written there. |
| `ODOS_SETUP_INTERACTIVE_ACK` | no | Set to `human-supervised` only when a human is intentionally running without a TTY. |
| `ODOS_MCP_TRANSPORT` | yes for the browser UI | Set to `sse` so the UI can call the local HTTP routes. The default `stdio` mode is for launch-on-demand MCP clients. |
| `ODOS_SMART_SIGNING_KEY_PATH` | yes for the local HTTP backend | Absolute path to the local mode-0600 SMART RS256 private key. |
| `ODOS_BACKUP_DIR` | no | Destination used by backup scripts and backup-destination verification. |
| `ODOS_COMMS_SMS_PROVIDER` | no | Transactional and marketing SMS adapter: `aws`, `twilio`, or `ghl`. Clinical SMS follows this adapter when `ODOS_COMMS_CLINICAL_SMS_PROVIDER` is omitted. Empty keeps SMS inert. Comma-separated values and the retired list-shaped variables fail startup instead of being coerced. |
| `ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER` | no | E.164 sender identity for transactional and marketing suppression scope. Omit during a one-number migration to preserve fail-safe global suppression until the sender number is configured. |
| `ODOS_COMMS_CLINICAL_SMS_PROVIDER` | no | Optional clinical SMS override: `aws` or `twilio`. `ghl` is rejected for this role as degraded routing because diagnosis-specific messaging requires the practice's BAA-covered lane. |
| `ODOS_COMMS_CLINICAL_SMS_NUMBER` | no | E.164 clinical sender identity. Defaults to `ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER` when the clinical role follows the transactional lane. |
| `ODOS_COMMS_STOP_SCOPE` | no | `per-number` (default) scopes new STOP records to the receiving sender identity; `global` makes every SMS opt-out suppress every lane. Legacy records without a number remain global under either setting. |
| `ODOS_COMMS_VOICE_PROVIDER` | no | One active Voice adapter: `twilio`, `ghl`, or `none`. A selected provider without the required calls capability is unavailable and logged as degraded. |
| `ODOS_COMMS_EMAIL_PROVIDER` | no | One active email adapter: `google-workspace` or `none`. |
| `AWS_SMS_REGION`, `AWS_SMS_ORIGINATION_IDENTITY`, `AWS_SMS_SQS_QUEUE_URL`, `AWS_SMS_SNS_TOPIC_ARN` | yes for AWS SMS | Same-region, same-account AWS End User Messaging phone-number ARN, standard SQS queue URL, and standard SNS topic ARN. See the AWS SMS setup guide. |
| `ODOS_TIMEZONE` | yes for reminders | IANA practice timezone used when no patient timezone is present. |
| `GHL_LOCATION_ID` / `GHL_ACCESS_TOKEN` | yes for GHL | Practice-owned HighLevel sub-account ID plus a location-scoped OAuth access token or Private Integration Token. Required scopes: `contacts.readonly`, `contacts.write`, `conversations.readonly`, `conversations/message.readonly`, and `conversations/message.write`. Configure HighLevel's signed `InboundMessage` webhook to `/comms/ghl/inbound`. |
| `TWILIO_VOICE_FROM_NUMBER` | yes for Twilio Voice | Practice-owned or verified Twilio caller ID in E.164 format. A Messaging Service SID cannot substitute for this Voice sender. |
| `TWILIO_VOICE_FORWARD_TO_NUMBER` | yes for Twilio Voice | Staff endpoint in E.164 format. Inbound calls route here; click-to-call rings this endpoint before dialing the patient. |
| `TWILIO_WEBHOOK_BASE_URL` | yes for Twilio webhooks | Exact public HTTPS origin configured in Twilio. Required for signature validation and for mounting the SMS/Voice webhook routes. |
| `TWILIO_VOICE_API_KEY_SID` / `TWILIO_VOICE_API_KEY_SECRET` | yes for Twilio Voice | Dedicated Restricted API key with the Voice permissions named in the Voice Slice A ledger. Do not widen or reuse a Messaging-only key. |
| `ODOS_HIPAA_MODE` | yes for a HIPAA-scoped Twilio deployment | Set to `true` to reject non-US SMS and Voice destinations and senders, including every enumerated Messaging Service phone number. It defaults to `false` so non-US ODOS deployments remain supported. The selected posture is logged at boot. |
| `TWILIO_REAL_TIME_TRANSCRIPTION_ENABLED` | no | Set to `true` to start webhook-only `<Transcription>` on Voice calls. ODOS does not configure Twilio transcript persistence and does not expose Batch Transcription v3. |
| `TWILIO_MEDIA_URL_AUTH_ACKNOWLEDGED` | yes for recording retrieval | Set to `true` only after the operator verifies **Enforce HTTP Auth on Media URLs** is enabled in Twilio Voice Settings. Recording retrieval and its webhook route remain disabled otherwise. |
| `ODOS_REMINDER_ENGINE_ENABLED` | no | Must be explicitly `true` after Google Workspace and BAA setup is confirmed. |
| `ODOS_REMINDER_LOOKBACK_MINUTES` | no | Bounded positive-offset recovery window; defaults to 1,440 minutes. Negative appointment reminders recover while the appointment is still upcoming. |
| `ODOS_COMMS_PUBLIC_BASE_URL` | yes for tracked education links | Reachable HTTPS base URL used by manual clinical education sends to generate `/comms/r/:token` redirect links. Blank values are treated as unset; during migration only, ODOS falls back to `ODOS_PRACTICE_PUBLIC_BASE_URL` with one startup warning. |
| `WESTFAX_USERNAME`, `WESTFAX_PASSWORD`, `WESTFAX_PRODUCT_ID`, `WESTFAX_CALLBACK_BASE_URL` | yes for fax | Server-only WestFax credentials, the practice fax-line ProductId, and the HTTPS callback origin. |
| `ODOS_INBOUND_FAX_WORKER_ENABLED` | no | Set to `true` to opt in to inbound polling after WestFax is configured; defaults to off. |
| `ODOS_INBOUND_FAX_WORKER_MS` | no | Inbound polling cadence in milliseconds; defaults to 180,000 (3 minutes), minimum 15,000. |

> **Which password is which — three distinct credentials, easily confused.** These three are
> routinely mistaken for one another, and the failure mode is a confusing authentication error
> rather than an obvious one:
>
> | Credential | Account | Where it works | Used for |
> |---|---|---|---|
> | **Your ODOS login** | `<your-odos-admin-email>` | the **deployed server** | signing in to ODOS day to day |
> | **ODOS admin password** | `<your-odos-admin-email>` | **each instance separately**, set at `setup-practice` | the *human* project admin; the identity `sync-practice-role-policy-rules`, `migrate-three-role-model` and the live-authz tests must authenticate as |
> | **`MEDPLUM_ADMIN_PASSWORD`** | `MEDPLUM_ADMIN_EMAIL` (e.g. `admin@laptop.odos.local`) | the instance that created it | break-glass service account only. It is **not** a project admin of the practice project and cannot sync policies. |
>
> The same email can exist on two instances with **different passwords** — a laptop dev stack and
> a deployed server do not share a database. When a command answers `User not found`, that is
> Medplum reporting *no membership in the target project*, not a bad password.
>
> To run any live-authorization or policy-sync command locally:
>
> ```bash
> read -rsp "ODOS admin password: " PW && echo
> MEDPLUM_ADMIN_EMAIL=<your-odos-admin-email> MEDPLUM_ADMIN_PASSWORD="$PW" \
>   npx tsx scripts/sync-practice-role-policy-rules.ts -- --project <practice-project-id>
> unset PW
> ```

Google Workspace communications setup and the documented manual-send verification path are in
[`docs/google-workspace-comms.md`](google-workspace-comms.md).
AWS End User Messaging SMS setup, including the manual SNS-to-SQS subscription and phone-number
two-way configuration, is in [`docs/aws-sms-comms.md`](aws-sms-comms.md).

Twilio Voice is all-or-nothing: the five Voice variables above must be present together. The
adapter does not automatically record calls. Batch Transcription v3 was removed from the adapter;
when explicitly enabled, Real-Time Transcription delivers utterances through the same signed
webhook wrapper as the other Twilio routes and does not set `intelligenceService`, so ODOS does
not request Twilio-side transcript persistence.

### Twilio HIPAA gating sequence

Complete this sequence before any real patient Voice, SMS, or MMS traffic:

1. Purchase Twilio Security or Enterprise Edition and execute a BAA. Twilio limits HIPAA Accounts
   to those editions. ([Twilio Editions](https://www.twilio.com/docs/iam/twilio-editions),
   accessed 2026-08-01; [Architecting for HIPAA](https://www.twilio.com/content/dam/twilio-com/global/en/other/hipaa/pdf/Architecting-for-HIPAA.pdf),
   accessed 2026-08-01.)
2. For a BAA initiated after 2024-06-06, create a Twilio Organization, add the practice account,
   execute the BAA, and explicitly designate every applicable existing account or subaccount as a
   HIPAA Project. Existing subaccounts are not designated automatically. ([Twilio Organizations](https://www.twilio.com/docs/iam/organizations),
   accessed 2026-08-01; [Architecting for HIPAA](https://www.twilio.com/content/dam/twilio-com/global/en/other/hipaa/pdf/Architecting-for-HIPAA.pdf),
   accessed 2026-08-01.)
3. In Twilio Console, open **Voice Settings**, enable **Enforce HTTP Auth on Media URLs**, save,
   and then set `TWILIO_MEDIA_URL_AUTH_ACKNOWLEDGED=true`. Twilio's documented Account REST
   resource and pinned Node SDK expose no field for reading this Console setting, so this flag is
   an operator acknowledgement, not an API-derived assertion. Without it, ODOS refuses to expose
   recording retrieval or the recording webhook route. ([Twilio media security](https://www.twilio.com/docs/usage/security),
   accessed 2026-08-01; [Twilio Account REST resource](https://www.twilio.com/docs/iam/api/account),
   accessed 2026-08-01; [twilio-node 6.0.2 Account resource](https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/api/v2010/account.ts),
   accessed 2026-08-01.)
4. Set `ODOS_HIPAA_MODE=true`. ODOS then fails closed on non-US destinations for both SMS and
   Voice and on non-US senders configured through `TWILIO_FROM_NUMBER` or
   `TWILIO_VOICE_FROM_NUMBER`. If `TWILIO_MESSAGING_SERVICE_SID` is used, startup enumerates the
   complete PhoneNumbers collection and rejects every sender whose ISO country code is not `US`.
   Do not combine `TWILIO_MESSAGING_SERVICE_SID` with `ODOS_COMMS_TRANSACTIONAL_SMS_NUMBER`
   or `ODOS_COMMS_CLINICAL_SMS_NUMBER` for a Twilio-routed lane. ODOS leaves each conflicting
   role unavailable and logs a degraded-routing issue while the rest of MCP continues starting;
   choose either the verified Messaging Service sender pool or the explicit lane sender number.
   Startup and sends share each pool-verification result for five minutes, then a send repeats the
   complete enumeration so a post-startup pool change cannot remain undetected. An empty pool,
   non-US member, missing country code, or API/auth/network failure keeps Twilio SMS disabled. It
   does not prevent the MCP server or unrelated clinical and administrative routes from starting.
   Five minutes bounds a deliberate Console mutation to a short window while collapsing a
   sequential reminder batch to one request against the no-SLA beta endpoint.
   A Restricted Messaging API key therefore also needs
   `twilio/messaging/services.phonenumbers/list`. ([Messaging Service PhoneNumbers API](https://www.twilio.com/docs/messaging/api/phonenumber-resource),
   accessed 2026-08-02; [twilio-node 6.0.2 PhoneNumber resource](https://github.com/twilio/twilio-node/blob/6.0.2/src/rest/messaging/v1/service/phoneNumber.ts),
   accessed 2026-08-02; [Restricted Messaging API-key permissions](https://assets.cdn.prod.twilio.com/documents/Twilio_Restricted_API_Keys_Permissions_-_Messaging_Permissions.pdf),
   accessed 2026-08-02.)

   Twilio currently labels the Services PhoneNumbers API Public Beta and provides no SLA for it.
   Treat the `communications provider "twilio" DEGRADED` startup error or a blocked send as an
   operational alert. The startup error names the underlying failure and the required restricted-key
   permission while the rest of ODOS continues booting. Check Twilio API availability, the API-key
   permission, network access, and every pool member; after correcting a startup failure, restart
   ODOS because the rejected initialization is retained to keep SMS fail-closed. A send-time failure
   remains cached until the five-minute window expires, when the next send attempts a fresh check.

   ODOS intentionally interprets Twilio's current "US area codes" requirement as ISO country
   code `US`. It conservatively rejects Puerto Rico, the US Virgin Islands, Guam, American Samoa,
   and the Northern Mariana Islands even though 45 CFR 160.103 includes them in HIPAA's definition
   of “State.” Twilio's primary HIPAA material does not expressly resolve territory coverage, so
   those destinations remain blocked until Twilio publishes an unambiguous eligible boundary.
   ([Architecting for HIPAA](https://www.twilio.com/content/dam/twilio-com/global/en/other/hipaa/pdf/Architecting-for-HIPAA.pdf),
   accessed 2026-08-02; [45 CFR 160.103, eCFR](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-160/subpart-A/section-160.103),
   accessed 2026-08-02; [45 CFR 160.103, 2025 annual edition](https://www.govinfo.gov/content/pkg/CFR-2025-title45-vol2/pdf/CFR-2025-title45-vol2-sec160-103.pdf),
   accessed 2026-08-02.)
5. If transcription is needed, set `TWILIO_REAL_TIME_TRANSCRIPTION_ENABLED=true`. This selects
   webhook-only Real-Time Transcription with Twilio's documented defaults: Google as the engine
   and `telephony` as the speech model. Twilio lists Google with any supported model delivered by
   webhook as HIPAA eligible. ODOS exposes no engine/model override; do not use Batch Transcription
   v3 for a PHI-bearing workflow. ([Real-Time Transcription TwiML](https://www.twilio.com/docs/voice/twiml/transcription),
   accessed 2026-08-02; [Real-Time Transcription HIPAA eligibility table](https://www.twilio.com/docs/voice/api/realtime-transcription-resource#hipaa-eligibility-and-pci-compliance),
   accessed 2026-08-02.)
### Inbound WestFax deployment

Inbound fax retrieval is a server-side polling workflow. WestFax credentials and downloaded PDF
content must stay in the local MCP service; never expose them through Vite variables or browser
storage. Configure the four `WESTFAX_*` values above, set
`ODOS_INBOUND_FAX_WORKER_ENABLED=true`, and restart `odos-core`. The worker polls unread inbound
faxes every three minutes by default. A failed local FHIR write leaves the fax unread at WestFax
for a later retry and logs the failure; it does not advance the vendor cursor.

The received PDF is stored inside its local FHIR `DocumentReference`. A sender-number match can
suggest a patient only when it resolves through a known referrer and exactly one prior inbound
referral; staff must still confirm every chart attachment. There is no automatic patient attach
path.

## Setup Wizard

Run:

```bash
npm run setup-practice
```

Equivalent direct entrypoint:

```bash
npx tsx scripts/setup-practice.ts
```

The wizard:

- Uses `auth/newuser` and `auth/newproject` for first-run admin/project creation.
- Creates the first `Practitioner`.
- Creates one active practice `Organization` named from `ODOS_PRACTICE_NAME` and one active
  `Location` for the existing `main` scheduling office. The Location points to the Organization;
  address and telecom are omitted because setup does not collect those values.
- Creates the canonical ODOS `front-desk`, `practice-admin`, and `clinician` AccessPolicies. (Since 2026-07-05, ODOS AccessPolicies carry a `practice-role` `meta.tag` — the payments endpoint derives a caller's role from it. Installs seeded before that date must run `npm run reseed-role-tags` with a human-provisioned, short-lived `MEDPLUM_ACCESS_TOKEN` set so existing policies gain the tag; the command conditionally patches only missing tags, reports role-tag or concurrent-write conflicts without overwriting them, and exits non-zero when conflicts exist.)
- Reconciles the named human administrator's `ProjectMembership.access[]` to `front-desk`, `practice-admin`, and `clinician`, with `front-desk` first so Desk mutations use the existing actor role.
- Stops before provisioning if `ODOS_ADMIN_EMAIL` matches the `MEDPLUM_ADMIN_EMAIL` break-glass account.
- Emits `odos_audit_events` rows with `actor_id = setup-wizard`, `actor_role = system`, and `action_reason = "v0.5d setup wizard first-run provisioning"`.
- Records resumable progress in `.odos-setup-state.json`.
- Creates or verifies a distinct `ODOS Local Operator` client in the exact project. Its
  policy-free, non-admin membership is used only by local maintenance scripts; setup stores its
  secret in `.odos/operator.env` with mode `0600`.

Downstream local tooling reads `organizationId` and `locationId` from the setup state at
`ODOS_SETUP_STATE_PATH` (default `.odos-setup-state.json`) and constructs
`Organization/<organizationId>` and `Location/<locationId>` references. TypeScript tooling can
use the exported `readSetupState(path)` helper from `scripts/setup-practice.ts`; no resource id is
hardcoded or stored through a second mechanism.

If setup has already completed, re-running the wizard exits cleanly:

```text
Practice already provisioned. To re-provision, see docs/install.md §Re-provisioning.
```

The no-op path emits an audit row with `event_type = noop` and `action_reason = "v0.5d setup wizard re-run, already provisioned"`.

### Dry-eye treatment configuration

After the MCP server is running, initialize the dry-eye series protocols and package definitions:

```bash
npm run seed-dry-eye-treatment
```

This idempotent step is required before the Dry Eye sheet's **Start IPL** action can create a
treatment-series CarePlan. It also installs the RF and LLLT protocol definitions and package
definitions. The command uses the local admin credentials from `.env` and stops on archived or
duplicate definitions rather than replacing them. Review the seeded package prices as practice
configuration; they are not clinical defaults. Existing installations must run this command once
because re-running `setup-practice` exits on its completed state and does not add the definitions.

### Local operator identity

The operator client is a non-human maintenance identity. It is not the human clinical admin, the
Medplum service login, or the default client Medplum creates with a project. Operator scripts
verify the exact project and named client profile through client credentials plus `/auth/me`.
Medplum 5.1.30 denies a client principal FHIR read access to its own extended membership, so the
script separately reads that one exact `ProjectMembership` row from the local Medplum Postgres
database to prove it is non-admin with empty `access[]` and no attached `accessPolicy`. Missing,
mismatched, constrained, or revoked state stops the script; there is no `ODOS_ADMIN_*` or
`MEDPLUM_ADMIN_*` fallback for the work itself. `ODOS_POSTGRES_URL` must resolve to localhost or
the local Compose `postgres` service.

Setup uses the Medplum service login only to create or manage this local client. The operator
credential stays under the gitignored `.odos/` directory and is forbidden by preflight in
`mcp/src` and `ui/src` request-serving code.

Quiesce all operator scripts before lifecycle changes. Rotate in the same project with:

```bash
npm run operator-identity -- --rotate --project <project-id>
```

Rotation creates and verifies the replacement before cutting over. If deletion of the old client
fails after cutover, `.odos/operator-previous.env` remains mode `0600` and lifecycle state records
the pending revocation. Re-run the same command to finish old-client deletion; it resumes rather
than creating another client. A process holding the old access token can fail or continue until
Medplum rejects or expires that token, which is why rotation is not an in-flight operation.

If `.odos/operator.env` may have leaked, revoke it explicitly:

```bash
npm run operator-identity -- --revoke --project <project-id>
```

This deletes the named membership and client, proves the old secret cannot exchange, removes the
active credential file, and writes a same-project `credential-exposure` tombstone. Ordinary setup
will not recreate it. After reviewing the exposure, create a replacement explicitly:

```bash
npm run operator-identity -- --replace-revoked --project <project-id>
```

A destructive rebuild is different: the new project ID causes setup to record
`replacementReason=project-rebuild` and create a new project-local client. A 5.1.8 process cannot
be pointed back at a volume migrated by 5.1.30; rollback requires another destructive rebuild, not
a volume restore.

Operator-client FHIR writes are deliberately outside the ODOS request-path audit wrapper. Setup
emits its existing selected audit rows, and FHIR history preserves resource versions and times,
but `seed-demo` does not currently emit a complete durable per-write actor/reason record. Treat
this as an accepted maintenance-plane audit gap, not as equivalent to Audit Slices 1 and 2.

## Legacy Import Transport Identity

Provision the non-superadmin migration client after the practice roles exist:

```bash
export ODOS_OPERATOR_ACCESS_TOKEN="<temporary token copied from a human-authenticated local Medplum session>"
npm run setup-legacy-importer
unset ODOS_OPERATOR_ACCESS_TOKEN
```

The setup command never accepts an administrator password and never performs a
login. Keep the temporary operator token in the current shell only; do not write
it to `.env` or `.odos/`.

The generated client credentials stay in `.odos/migration-importer.env`. See
[`docs/legacy-import-m0.md`](legacy-import-m0.md) for the raw Binary transport,
Media recovery, operator sweep, and direct-FHIR acceptance gate.

## Repair a Partially Provisioned Local Practice

If the setup state says the practice is complete but one or more canonical ODOS role policies are missing, repair the local project without resetting Postgres:

```bash
npm run repair-practice-roles -- --email "$HUMAN_EMAIL"
```

The repair authenticates with the configured Medplum service credentials but grants only to the explicit `--email` target. It does not create or change credentials. It is restricted to local or private Medplum URLs. It creates any missing canonical policy from the shipped five-role registry, adds a missing role tag to one unambiguous canonical policy, and ensures the target membership has `front-desk`, `practice-admin`, and `clinician` role entries first while preserving every distinct existing access grant. Production role resolution aggregates every bound role in registry order, so role-entry order does not require per-session changes. The command refuses a target matching `MEDPLUM_ADMIN_EMAIL`.

The repair collapses only exact duplicate policy bindings with the same reference and parameters, migrates the legacy `accessPolicy` field into ordered `access[]`, clears the legacy field, and is idempotent. It stops without writing the membership when it finds duplicate canonical policy names, a conflicting ODOS role tag, an ambiguous membership, or a stale resource version.

This is the normal recovery path for partial local provisioning. A volume wipe is not required.

## Developer Screen Bring-up

After the Compose stack is running, copy both environment templates and fill in
the root `.env` with the local developer credentials. Keep
`VITE_ODOS_MCP_BASE_URL=http://localhost:3333` in `ui/.env`:

```bash
test -e .env || cp .env.example .env
test -e ui/.env || cp ui/.env.example ui/.env
```

When either template gains new variables, diff its `.env.example` against the existing `.env`
and copy the additions deliberately.

If this developer account did not receive its one-time role grant during setup, repair the partial provisioning once:

```bash
npm run repair-practice-roles -- --email "$HUMAN_EMAIL"
```

Start the two checked-in launch configurations in `.claude/launch.json`:

| Launch | Address | Purpose |
|---|---|---|
| `odos-mcp` | `http://localhost:3333` | ODOS service routes used by Desk, Statements, and Clinic. |
| `odos-ui` | `http://localhost:5173` | Browser UI; requires `odos-mcp` to be running. |

The `odos-mcp` launch must run with `ODOS_MCP_TRANSPORT=sse`; otherwise it starts only the stdio MCP transport and does not expose the browser-facing HTTP routes. Generate an RSA-2048 local SMART signing key once before starting the backend:

```bash
mkdir -p .odos/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out .odos/keys/smart-signing.pem
chmod 600 .odos/keys/smart-signing.pem
export ODOS_SMART_SIGNING_KEY_PATH="$PWD/.odos/keys/smart-signing.pem"
```

Keep the private key outside git and preserve its `0600` permissions. Node must
be able to parse it as a private key, and the service enforces the exact mode and
fails closed if the path is missing or the mode is not `0600`. Put the absolute
path emitted by the export command into the root `.env`.

Start the backend from the `mcp/` package in one terminal. There is no root-level
backend start script; load the root environment before changing directories:

```bash
set -a
source .env
set +a
cd mcp && npm run dev
```

Start the UI in a second terminal:

```bash
cd ui && npm run dev
```

Open `http://localhost:5173`, then sign in through the ODOS login screen with the human account named by `--email`. Keep that account distinct from the `MEDPLUM_ADMIN_EMAIL` break-glass account; no password is stored in this repository. The UI is inert unless the backend is running on `http://localhost:3333`.

### Remote Browser Access

Keep both development services bound to loopback. The MCP server intentionally
fails closed if its SSE transport is bound to `0.0.0.0` or any other
non-loopback host without `ODOS_MCP_TLS`; do not set that variable merely to
bypass the control. From the operator workstation, tunnel both loopback
services instead:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 5173:127.0.0.1:5173 -L 3333:127.0.0.1:3333 <user>@<host>
```

If either local port is already in use, SSH exits instead of leaving a partial tunnel that can
make the browser show a different local application.

Then open `http://localhost:5173` on the operator workstation. The tunnel keeps
the shipped `VITE_ODOS_MCP_BASE_URL=http://localhost:3333` default correct, so
remote access does not require exposing either service or overriding the UI
backend URL.

To open a patient chart directly, use `http://localhost:5173/clinic?patientId=<id>`; add `&encounterId=<id>` to open a specific encounter.

With both dev servers running, seed synthetic screen data:

```bash
export MEDPLUM_PROJECT_ID=<project-id>
npm run seed-demo
```

The idempotent seed loads only the verified dedicated operator credential. It creates one clearly
synthetic `TEST-` patient, provider, visit type, schedule, current-day appointment, issued Invoice,
and $25 unapplied prepaid credit. It generates the patient's statement by invoking the statement
domain workflow locally; the operator bearer token is never sent through an MCP request. Re-running
the seed keeps the existing marked resources and statement.

Regular bring-up after the one-time repair is: start Compose, start `odos-mcp` and `odos-ui`, open `http://localhost:5173`, and use the regular local login. Run `npm run seed-demo` only when the synthetic demo rows are missing.

### Practice-role policy synchronization

Before restarting `odos-mcp` after a deployment, compare every deployed practice-role policy's
`resource[]` with the declarations in `mcp/src/authz/roles.ts`:

```bash
npm run sync-practice-role-policy-rules -- --project "$MEDPLUM_PROJECT_ID"
```

The default is a read-only dry run. Review every named missing and unexpected rule, then apply the
same plan explicitly when the differences are intended:

```bash
npm run sync-practice-role-policy-rules -- --project "$MEDPLUM_PROJECT_ID" --apply
```

Start `odos-mcp` only after that sync step. At boot, the server repeats the read-only `resource[]`
comparison. Drift produces a red warning that names the affected policy and rule differences, but
does not stop the server. MCP clients can request `get_policy_sync_status` at any time for the same
structured, read-only comparison; `inSync: true` means every declared practice role matches.

A `403` from the dry run or status tool is an identity-binding failure, not proof of policy drift.
Inspect the authenticated `ProjectMembership` and confirm that it belongs to the target project and
is bound to an AccessPolicy that can read AccessPolicy resources. Do not broaden a role policy merely
to make this diagnostic succeed.

## Re-provisioning

For an empty test stack, stop the services, invalidate the canonical installation manifest and all
project-derived operator/importer state, then reset the volumes. These removals are one deliberate
reseed operation; do not restart MCP between them:

```bash
docker-compose down -v
rm -f .odos-setup-state.json .odos/operator.env .odos/operator-previous.env \
  .odos/operator-identity.json .odos/migration-importer-state.json \
  .odos/migration-importer.env
docker-compose up -d
npm run setup-practice
```

`.odos-setup-state.json` is the canonical installation manifest. Its `projectId` is stable for the
life of an installation and changes only during a deliberate reseed/reinstall, never during normal
operation. Setup writes the replacement manifest atomically after Medplum creates the project.
MCP and operator scripts refuse to run until `MEDPLUM_PROJECT_ID`, operator credentials, and
migration state either agree with the new manifest or have been regenerated. Use an explicit
`--project <id> --allow-foreign-project` only for intentional foreign-project work; the target and
its source are printed before authentication.

Do not run this against live patient data. For a live practice, export audit/backup evidence first and make a deliberate operator decision.

## Preflight Linter

Run before live patient data:

```bash
npm run preflight
```

Equivalent direct entrypoint:

```bash
npx tsx scripts/preflight-lint.ts
```

Reports are written to:

- `.odos/preflight-report.json`
- `.odos/preflight-report.md`

The linter runs four local passes:

| Pass | Result type | Scope |
|---|---|---|
| Log scrubbing | warning | Recent local stack logs for PHI-shaped values. |
| Resource-name linting | warning | Opaque FHIR resource names/descriptions/titles. |
| Env-var PHI check | hard block | Running compose environment values. |
| Vendor-canonical-shape lint | hard block | Source-tree patterns forbidden by the v0.5 verification ledger and lessons. |

There is no data-residency pass in v0.5d because ODOS is local-only.

## Audit Verification

After setup and preflight, run the canonical synthetic Tier-1 visit audit check:

```bash
npm run audit-verify
```

Expected output includes:

```json
{
  "baseline": 8,
  "odosAuditRows": 8,
  "fhirAuditEvents": 8
}
```

This helper charts one synthetic test visit with a Patient, comprehensive Encounter start, five clinical Observations (visual acuity, refraction, IOP, anterior segment, posterior segment), and sign/finish. It verifies both the append-only `odos_audit_events` rows and the projected FHIR `AuditEvent` resources for that visit. The single-visit Tier-1 baseline is **8 ODOS audit rows + 8 FHIR AuditEvent projections**. If a companion bet still says the visit baseline is `32`, correct the bet: `32` belongs to DR drill canonical checks, not to one charted visit.

To re-check the count from the `sessionId` printed by `npm run audit-verify`:

```bash
export ODOS_POSTGRES_URL="${ODOS_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5433/medplum}"
export SESSION_ID="tier1-visit-<from audit-verify output>"

psql "$ODOS_POSTGRES_URL" -v session_id="$SESSION_ID" <<'SQL'
WITH visit_rows AS (
  SELECT id::text, event_type
  FROM odos_audit_events
  WHERE session_id = :'session_id'
),
projected AS (
  SELECT DISTINCT ae.id
  FROM "AuditEvent" ae
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ae.content::jsonb->'entity', '[]'::jsonb)) AS entity_item(value)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(entity_item.value->'detail', '[]'::jsonb)) AS detail_item(value)
  JOIN visit_rows vr ON detail_item.value->>'type' = 'odos_audit_event_id'
    AND detail_item.value->>'valueString' = vr.id
  WHERE ae.deleted = false
)
SELECT
  (SELECT count(*) FROM visit_rows) AS odos_audit_rows,
  (SELECT count(*) FROM projected) AS fhir_audit_events,
  (SELECT jsonb_object_agg(event_type, count)
   FROM (SELECT event_type, count(*) FROM visit_rows GROUP BY event_type) counts) AS event_types;
SQL
```

## Backup Destination

See [`docs/backup.md`](backup.md). To verify a candidate local or attached-drive destination:

```bash
npm run verify-backup-destination -- /Volumes/ODOS-Backups
```

The helper checks writability, available space, and at-rest encryption signals. Encryption findings are warnings; the practice owns the physical-safeguards decision.

## Port Collisions

If startup fails, check common ports:

```bash
lsof -nP -iTCP:8103 -sTCP:LISTEN
lsof -nP -iTCP:8100 -sTCP:LISTEN
lsof -nP -iTCP:5433 -sTCP:LISTEN
lsof -nP -iTCP:6379 -sTCP:LISTEN
```

Stop the conflicting local service or edit the root `docker-compose.yml` port mappings before first live use. Keep the compose file as the canonical local stack; do not introduce alternate deploy templates.

For the recurring case where another practice system owns the standard Postgres host port `5432`, leave that service running. ODOS publishes its own Postgres on host port `5433`:

```yaml
ports:
  - "127.0.0.1:5433:5432"
```

Only the left-side host port is remapped. The container-network URL has no password;
Compose supplies `PGPASSWORD` from `MEDPLUM_DATABASE_PASSWORD`:

```yaml
ODOS_POSTGRES_URL: postgresql://medplum@postgres:5432/medplum
```

Then make the host-run tooling URL match the new host port in `.env`:

```bash
ODOS_POSTGRES_URL='postgresql://medplum:<encoded-password>@127.0.0.1:5433/medplum'
```

Use the same URL for host-side `psql`, setup, preflight, and audit verification:

```bash
export ODOS_POSTGRES_URL='postgresql://medplum:<encoded-password>@127.0.0.1:5433/medplum'
docker-compose up -d
psql "$ODOS_POSTGRES_URL" -c "select 1;"
npm run setup-practice
npm run preflight
npm run audit-verify
```

## Troubleshooting

If `docker-compose up -d` fails:

```bash
docker-compose logs --tail 200 postgres
docker-compose logs --tail 200 redis
docker-compose logs --tail 200 medplum-server
```

If the setup wizard cannot reach Medplum:

```bash
curl -v http://localhost:8103/healthcheck
docker-compose ps
```

If audit rows fail:

```bash
docker-compose ps postgres
psql "${ODOS_POSTGRES_URL:-postgresql://medplum:medplum@127.0.0.1:5433/medplum}" -c "select count(*) from odos_audit_events;"
```

If preflight hard-blocks on env-var PHI, remove the PHI-shaped value from the environment, restart the local stack, and rerun `npm run preflight`.

ODOS is designed for your own hardware. If you have a strong reason to want cloud, that is a separate conversation; the engine ships local-only.
