# Person collection-equality review observation

PR-Agent alleged that one common entry would allow staff to change a Person's link collection. This was **not reproduced** at `b67a9395d1b4a0e150a8ee1bfc259301aaae82f3` against the existing disposable Medplum 5.1.30-9b1bd92 stack. The expression and both real AccessPolicies remained unchanged.

The [HL7 normative equality definition](https://hl7.org/fhirpath/N1/index.html#equals) and [pinned Medplum array-equality implementation](https://github.com/medplum/medplum/blob/9b1bd92e987aecdd338ac690b1d368ff11d7ceba/packages/core/src/fhirpath/utils.ts#L282-L290), both accessed 2026-09-14, require each corresponding item to match and reject different nonempty cardinalities. A shared entry is insufficient. The verification ledger records this agreement as G2B-M7.

A, B and C below are distinct synthetic RelatedPerson references attached to the fixture's synthetic Patient. For each principal, the probe created a Person with [A,B]. Every request used a fresh Person read and its current If-Match version. After each refusal, another read confirmed unchanged links and version.

| Requested change | Staff | Composite |
|---|---:|---:|
| [A,B] to [A,C] | 403 | 403 |
| [A,B] to [A] | 403 | 403 |
| [A,B] to [A,B,C] | 403 | 403 |
| [A,B] to no `link` property | 403 | 403 |
| Keep [A,B], change only name | 200 | 200 |

All ten observations passed across 35 HTTP exchanges. The complete-removal request omits `link` from its serialized FHIR JSON, so `%after.link` is empty; both principals receive 403 and the subsequent read preserves both original links and the original version. The positive name writes establish that these principals could update the same resources. No policy or membership was changed. Source SHA-256 before and after was `afdd50b756f907121ccfeb965abdd72d8981739992c1d21f111d4568087cf114`.

[Actual result](person-collection-review-proof.json), [redacted HTTP trace](person-collection-review-http.json), and [probe source](person-collection-review-proof.mjs) retain the evidence. The script uses the existing private synthetic fixture through `G2B1_SOURCE_ROOT`, `G2B1_LIVE_DIR`, and `G2B1_EVIDENCE_DIR`:

```sh
node --import ./mcp/node_modules/tsx/dist/loader.mjs docs/build-log/guarantor-g2b1/person-collection-review-proof.mjs
```

This is an author observation used to adjudicate one bot finding. The committed L18 policy-removal controls already demonstrate the constraint; these ten observations do not add mutation controls or constitute an independent evaluation. No application or existing test change was made for this finding.

The proof pass flag includes source-digest equality. [Evidence validation](evidence-validation.json) records the actual extracted summary predicate with differing synthetic digests: the guard passes, removing the equality condition makes it fail, and restoration passes again. No application or policy was mutated for this instrument check.
