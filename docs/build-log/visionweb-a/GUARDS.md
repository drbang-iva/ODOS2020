# Mutation proofs

Dedicated synthetic Postgres supplied via ODOS_POSTGRES_URL. Each defect is restored before its green run. Counts include all tests in the named files.

## V1

Mutation: `mcp/src/integrations/visionweb/config.ts` — entries.every(

Command: `npm --prefix mcp test -- tests/visionWebConfig.test.ts`

RED (exit 1):
```text
not ok 1 - V1 config rejects each absent field, bad URL and every invalid account
# tests 2
# pass 1
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

## V2

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — assertVisionWebTransmission(config);

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 1 - V1 V2 V3 invalid setup and V5 invalid order cause no writes or network
# tests 8
# pass 7
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V3

Mutation: `mcp/src/integrations/visionweb/config.ts` — accounts(config)!.get(lab.trim())

Command: `npm --prefix mcp test -- tests/visionWebConfig.test.ts tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 2 - V2 production flag is exact and V3 lab lookup uses configured keys only
not ok 3 - V1 V2 V3 invalid setup and V5 invalid order cause no writes or network
# tests 10
# pass 8
# fail 2
# skipped 0
```
GREEN (exit 0):
```text
# tests 10
# pass 10
# fail 0
# skipped 0
```

## V4

Mutation: `mcp/src/integrations/visionweb/vwOrderSerializer.ts` — value.toFixed(digits)

Command: `npm --prefix mcp test -- tests/vwOrderSerializer.test.ts`

RED (exit 1):
```text
not ok 1 - V4 golden field order, exact precision and one-eye serialization
# tests 4
# pass 3
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V5

Mutation: `mcp/src/integrations/visionweb/vwOrderSerializer.ts` — ${[...errors].join(", ")}

Command: `npm --prefix mcp test -- tests/vwOrderSerializer.test.ts`

RED (exit 1):
```text
not ok 2 - V5 required fields are aggregated
not ok 3 - V6 invalid values throw without rounding or truncation, aggregated
# tests 4
# pass 2
# fail 2
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V6

Mutation: `mcp/src/integrations/visionweb/vwOrderSerializer.ts` — else { errors.add(name); return; }

Command: `npm --prefix mcp test -- tests/vwOrderSerializer.test.ts`

RED (exit 1):
```text
not ok 3 - V6 invalid values throw without rounding or truncation, aggregated
# tests 4
# pass 3
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V7

Mutation: `mcp/src/integrations/visionweb/vwOrderSerializer.ts` — return value.replace(/&/g,

Command: `npm --prefix mcp test -- tests/vwOrderSerializer.test.ts`

RED (exit 1):
```text
not ok 4 - V7 XML escaping preserves the original text
# tests 4
# pass 3
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V8a

Mutation: `mcp/src/integrations/visionweb/uploadResponse.ts` — const status = required("Status");

Command: `npm --prefix mcp test -- tests/visionWebUploadResponse.test.ts`

RED (exit 1):
```text
not ok 2 - V8a malformed, missing, multiple and unknown upload results fail closed
# tests 2
# pass 1
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

## V9

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — let task=await fhir.create<Task>

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 2 - V9 write-ahead outcome states and audits
not ok 3 - V9 failed upload-state writes never remove the reservation
# tests 8
# pass 6
# fail 2
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V10

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — const detail=sanitizeVendorText(result.errorList??"",visionWebSecrets(config));

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 7 - V10 adversarial vendor errors cannot leak into Tasks, audit or thrown errors
# tests 8
# pass 7
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V11

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — if((await findActiveTransmissions(fhir,req.orderTaskReference)).length)

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 4 - V11 existing active Task refuses resubmission and V14 distinct orders use distinct message ids
not ok 5 - V12 cancellation and advancement enforce the upload-state lock
# tests 8
# pass 6
# fail 2
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V12-cancel

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — permit unknown cancellation

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 5 - V12 cancellation and advancement enforce the upload-state lock
# tests 8
# pass 7
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V12-advance

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — permit transition rules before the upload-state gate

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 5 - V12 cancellation and advancement enforce the upload-state lock
# tests 8
# pass 7
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V13

Mutation: `mcp/src/integrations/visionweb/visionWebClient.ts` — const key = scope;

Command: `npm --prefix mcp test -- tests/visionWebClient.test.ts`

RED (exit 1):
```text
not ok 1 - V13 token request, scope and config isolation, expiration and absent expiry
# tests 4
# pass 3
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V14

Mutation: `mcp/src/lab-orders/adapters/visionweb-lab-order-adapter.ts` — msgguid:randomUUID()

Command: `npm --prefix mcp test -- tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 4 - V11 existing active Task refuses resubmission and V14 distinct orders use distinct message ids
# tests 8
# pass 7
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 8
# pass 8
# fail 0
# skipped 0
```

## V15

Mutation: `mcp/src/lab-orders/lab-order-dispatch.ts` — if (vendor !== "manual" && vendor !== "ocuco-gatekeeper")

Command: `npm --prefix mcp test -- tests/labOrderDispatch.test.ts`

RED (exit 1):
```text
not ok 4 - unknown or unconfigured lab-order vendors fail closed with explicit messages
# tests 6
# pass 5
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 6
# pass 6
# fail 0
# skipped 0
```

## V16

Mutation: `mcp/src/integrations/visionweb/visionWebClient.ts` — catch { throw new Error(`VisionWeb ${operation} failed.`); }

Command: `npm --prefix mcp test -- tests/visionWebClient.test.ts`

RED (exit 1):
```text
not ok 2 - V14 SOAP fields and V16 no retries, redirect and HTTPS at each client boundary
# tests 4
# pass 3
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 4
# pass 4
# fail 0
# skipped 0
```

## V17

Mutation: `mcp/src/lab-orders/lab-transmission-helpers.ts` — if (existing.link?.some(link=>link.relation==="next"))

Command: `npm --prefix mcp test -- tests/labTransmissionHelpers.test.ts`

RED (exit 1):
```text
not ok 1 - V17 active transmissions enforce type, reference, terminal state and one-page boundary
# tests 1
# pass 0
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

## R10-V8a

Command: `node --import tsx --test --test-name-pattern=V8a mcp/tests/visionWebUploadResponse.test.ts`

RED (exit 1):
```text
not ok 2 - V8a malformed, missing, multiple and unknown upload results fail closed
# tests 2
# pass 1
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 2
# pass 2
# fail 0
# skipped 0
```

## R10-V8b

Command: `node --import tsx --test --test-name-pattern=V8b mcp/tests/visionWebUploadResponse.test.ts`

RED (exit 1):
```text
not ok 1 - V8b captured SOAP service error has no invented order identity or acceptance
# tests 1
# pass 0
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

## R10-V10-echo

Command: `node --import tsx --test --test-name-pattern=V10 captured mcp/tests/visionWebLabOrderAdapter.test.ts`

RED (exit 1):
```text
not ok 1 - V10 captured LOGIN echo reaches no Task, audit, thrown error or console; service errors stay locked
# tests 1
# pass 0
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 1
# pass 1
# fail 0
# skipped 0
```

## R10-boundaries

Command: `node --import tsx --test --test-name-pattern=R10 fixture credential mcp/tests/visionWebQaLive.test.ts`

RED (exit 1):
```text
not ok 1 - R10 fixture credential boundaries honor per-variable case and regex characters
# tests 1
# pass 0
# fail 1
# skipped 0
```
GREEN (exit 0):
```text
# tests 1
# pass 1
# fail 0
# skipped 0
```
