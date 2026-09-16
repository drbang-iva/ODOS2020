# CL-A live backend proof

Executed `node --import tsx docs/build-log/guarantor-cleanup-a/live/operation-proof.mjs` against the isolated fixture on port 28860, real application routes on port 28865. Actual staff authentication, AccessPolicy enforcement, service-identity conditional writes and database audit persistence.

Final result: **6 scenarios, 75 assertions, 0 failures**. Parent runtime head `ab001d310ce118e6ff0e57b26d31adc14d8edabf` remained unchanged, as did all captured source hashes.

- Create → listed → real discard → inactive/unlinked, absent from list, second discard409.
- Raw staff Person.active PUT403 (O10).
- Real attach → Move → retained source inactive and excluded/refused by cleanup → existing Undo reactivates and restores source ownership.
- X1 for attach, transfer and consolidate: discard passes scan, attach records its real Task, discard lands, attach resumes and pauses attach-pending. Complete returns409 destination-inactive without any service transaction writes. Destination remains inactive/unlinked. Existing Undo releases the claim; attach leaves no owner, while transfer/consolidate restore the previous owner.
- X2: attach finishes while discard's conditional PUT is delayed. Discard409; Person remains active and linked.
- G1 checked on every operation snapshot. Persisted discard audit rows match the actual staff actor and submitted reasons.

Requests, responses, interleaving transactions, final resources and audit records are in `operation-http.json` and `operation-proof.json`. Only synthetic loopback fixture records are present. Private-value leak scan passed.

An initial harness run incorrectly sent GET for Complete and received404; the proof helper was corrected to POST. No application change resulted. The final executable passed twice (71 assertions first; 75 after adding explicit audit checks).

Proof server and audit client closed at exit. Fixture containers remain running for parent UI proof. Author evidence only — NOT EVALUATED.
