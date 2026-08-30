# Watcher Engine 2A Design

## Purpose and scope

Slice 2A creates the reusable watcher engine, implements W1 end to end, and adds the Today digest. A watcher is one question, one firing rule, one owner, one named next action, and one plain-language consequence. Registration is a startup gate: an invalid watcher definition stops startup and names every missing rule.

Only W1 ships in this slice. W2-W7, Week, Scorecard, the five-tab Billing shell, Ask, and email delivery are absent rather than stubbed. `/desk` remains unchanged. No file under `mcp/src/claims/` is touched.

## Watcher definition and practice configuration

The code registry carries executable watcher definitions. Each definition must provide:

- a stable watcher id and one question;
- one evaluation function as its firing rule;
- one owner role or named owner;
- one primary action label and target builder;
- one plain-language consequence;
- a copy register (`front-desk`, `owner`, or `biller`);
- dismissal reason codes with human labels;
- an activation kind (`immediate`, `fixed-threshold`, or `learned-baseline`);
- seeded practice settings, including severity and any thresholds.

Runtime registration validates unknown input rather than trusting TypeScript. Missing or blank fields, multiple primary actions, an empty dismissal catalog, or an invalid severity throw `WatcherRegistrationError` during process startup. Error text identifies the watcher and failed rule. W1 asks which patients on today's schedule have an open balance, is owned by the front-desk queue, names `View balance & collect` as its action, and states that collecting at check-in works better than another statement.

Effective settings live in a coded FHIR `Basic` singleton. Its seeded data contains `goLiveAt`, `needsHumanCap` (seed 5), `staleAfterMinutes`, and per-watcher settings. W1 starts with severity `today` and `minimumBalanceCents: 1`. The seed exists only to create the practice-owned record; every later evaluation reads the persisted record. No IVA-sized constant exists.

## FHIR persistence

Each fired condition is one FHIR R4 `Task`:

- `identifier` is the stable condition key `W1:Appointment/{id}`;
- `code` identifies W1;
- `for` references the patient;
- `focus` references the appointment row;
- `owner` names the front-desk queue or a reassigned practitioner;
- `status` tracks requested, on-hold, completed, or cancelled;
- `statusReason` stores the typed dismissal or snooze reason;
- `businessStatus` stores the effective `today | this-week | watch` tier;
- `description` stores the current one-line owner-register message;
- `restriction.period.start` stores the appointment instant;
- typed Task inputs store the consequence, primary action, balance cents, balance age, and source invoice count needed for deterministic rendering.

Creation uses `If-None-Exist` with the condition identifier. When the same condition fires again, the engine updates the returned Task in place and preserves terminal dismissal. A no-longer-matching active condition becomes completed. Firing twice therefore yields one Task and one card.

A second coded `Basic` singleton stores engine health: last attempt, last success, outcome, and failure detail. Failed evaluation preserves the prior success timestamp. Read routes return HTTP 503 with structured degraded health and no alerts when the last attempt failed or the last success is older than the persisted freshness threshold. Existing Tasks are never returned as current under degraded health.

## Evaluation and W1

The worker authenticates the existing service client, runs immediately at startup, and repeats on an injected interval. Its registry is built before the worker starts, so grammar failure is a startup failure. The production worker derives the evaluation day from the practice timezone rather than UTC.

W1 evaluates the current practice day:

1. Convert the practice day to explicit timezone-aware midnight bounds, then read every non-cancelled Appointment in that interval while following FHIR next links.
2. Resolve every referenced Patient in bounded batches.
3. Read every issued Invoice and every active PaymentReconciliation, following FHIR next links, and join by patient and Invoice reference.
4. Compute each Invoice's remaining amount from `Invoice.totalNet` less completed payment allocations, floor overpayment at zero, and retain the oldest still-open Invoice date. An issued Invoice carrying the record-only tender marker represents a partial manual payment whose amount is not persisted; W1 fails the sweep instead of claiming zero or the original total.
5. Sum positive remaining amounts for each scheduled patient.
6. Emit one condition per matching Appointment whose persisted minimum is met.

Each paginated search has a 100-page and 10,000-resource guard. Exceeding either guard, lacking next-link support, or receiving malformed financial data fails the entire W1 run. The health record becomes failed; no partial alert list is published.

W1 uses `immediate` activation. It can fire on day one because the actionable event is today's appointment, even when the debt predates ODOS. The generic engine suppresses `fixed-threshold` matches whose source event predates `goLiveAt`; Mandate 17 proves that separately with a test watcher.

## API and actions

Authenticated staff routes use the existing staff authentication seam. Read routes require `billing-context.read`; the action route requires the dedicated `watchers.manage` capability granted to front-desk Staff and owner/Admin, not Provider. Only a Task carrying both the ODOS watcher code system and watcher condition identifier can be changed. The process service FHIR client runs only after those app-level gates. This slice changes no authentication flow, credential, or AccessPolicy. Explicit dates must round-trip as real Gregorian calendar dates; impossible dates are rejected rather than normalized.

- `GET /watchers/frontdesk?date=YYYY-MM-DD` returns fresh W1 projections keyed by Appointment id or a structured 503 degradation.
- `GET /watchers/today?date=YYYY-MM-DD` returns fresh ranked/capped Today data, yesterday comparison, overflow groups, and the go-live date or a structured 503 degradation. When the client omits `date`, the server chooses the current practice day.
- `POST /watchers/tasks/:taskId/action` accepts one validated action: dismiss with a W1 reason code, snooze until an ISO instant, reassign to a valid practitioner reference, or resolve after collection.

Dismissal writes `Task.status = cancelled` plus coded `statusReason`. Snooze writes `on-hold`, a coded reason, and a future restriction end. Reassignment writes `Task.owner`. The existing recorded-tender collection path requires the collected amount to equal the selected charge total and now persists that fully paid Invoice as `balanced`; untendered processor bills and genuine partial manual payments remain `issued`. An older `issued` Invoice with a tender marker is intrinsically ambiguous because the prior seam did not persist the amount paid; W1 names that Invoice and degrades rather than guessing it paid or unpaid. Resolve must name the same Patient as `Task.for`; the server reruns that watcher's firing rule and writes `completed` only when the same condition key is no longer active. A partial collection therefore leaves the existing Task open. Cancelled, completed, failed, rejected, and entered-in-error Tasks reject every later action so a stale browser cannot resurrect terminal work. All actions preserve the Task identifier and therefore never create another notification.

## Front-desk rendering

`/frontdesk` is the only front-desk home in 2A. `FrontDeskCockpit` loads watcher state and passes it into the day scheduler.

The Appointment block visibly carries a compact `$132 balance` cue tied to the matching Task. Selecting that row opens the existing Patient Quick Card with the full front-desk register message, consequence, one `View balance & collect` action, and overflow reasons `already collected`, `payment plan`, and `waived`. The action opens the existing collection panel in the appointment context. Today deep-links to that appointment row and opens the same quick-card rendering.

When health is failed or stale, the cockpit shows a system-level degraded notice with the last successful time. It shows no balance cues and no W1 quick-card content.

## Today rendering

Today is a direct `/billing/today` route with no tab shell. Only effective `today` tasks are eligible for Needs a human. Ranking is severity, dollars at risk descending, then balance age descending. The persisted cap defaults to five. Overflow is one line with remaining count grouped by watcher reason.

Each card shows severity, one-line owner-register message, consequence, one primary action, and overflow controls for snooze, dismiss with reason, and reassign. The same Task id backs the cockpit and Today renderings.

Since yesterday compares W1 Tasks for today and the prior practice day. Both periods show patient count beside dollars; the current level shows count and dollars deltas beside it. A healthy empty state says `Nothing needs a human today — watching since {go-live date}.` A failed or stale engine never renders that assertion.

## Verification contract

Automated tests and explicit reversible mutations demonstrate:

1. Missing owner and, separately, missing next action refuse registration and name the rule.
2. Eight eligible alerts render as five plus one overflow line; disabling the cap renders eight; restoration renders five plus overflow.
3. Pre-go-live fixed-threshold records are suppressed; disabling suppression floods; restoration suppresses.
4. More Invoice rows than a read boundary can safely cover degrades loudly; disabling completeness detection silently misses balances; restoration degrades.
5. Firing the same condition twice leaves one Task/card.
6. Failed or stale health blocks existing Tasks in both projections; disabling freshness renders stale Tasks; restoration returns degraded state with last success.

Final gates are `cd mcp && npm run build`, `cd mcp && npm test`, `cd ui && npm run build`, and root `npm run preflight`. The known clean-main `clinicalWriteAuthzLive` failure remains separately identified if reproduced.
