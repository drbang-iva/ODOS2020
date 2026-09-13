# Responsible parties UI guard evidence

Run from `ui/`: `node --import tsx --test tests/guarantorEditor.test.tsx tests/demographicsConcurrency.test.tsx`.

Restored result in `green.txt`: 7 passed, 0 failed. This includes 4 guarantor UI tests and the unchanged 3 demographicsConcurrency tests.

Each mutation was applied alone, tested with `--test-name-pattern='<pattern>'`, and immediately restored:

| Guard / pattern | Deliberate mutation | Observed red |
| --- | --- | --- |
| Q10 | Replace the non-editable save-handler refusal with `POST Person` while leaving the button disabled | `q10-red.txt`: direct handler invocation captured `POST Person` instead of empty write set; 1 failed |
| Q11 | Initialize the result state to undefined, discarding mount-time classification | `q11-red.txt`: no Repair offer on the clean form; 1 failed |
| Q12 | Disable `persons.length !== 1` refusal in `resolveGuarantor` so lookup picks the first Person | `q12-red.txt`: editable form replaced the required ambiguity report; 1 failed |
| editing one name | Remove the dirty-form guard from the Repair handler while retaining the disabled button | `dirty-repair-red.txt`: direct Repair invocation writes and discards unsaved draft; 1 failed |
| editing one name | Drop all but the first phone from the loaded demographics draft | `preservation-red.txt`: fresh persisted telecom lost the duplicate home, email and fax; 1 failed |

The fixtures persist independent clones and read fresh transport responses. No credentials or real patient data were used. Q10 invokes the disabled save handler directly. Q11 performs repair and checks persisted child name, telecom and address against the current Person. Raw-array preservation checks compare persisted resources after a real component Save action and capture the outgoing write set. Test-output paths were replaced with `<worktree>/`.


## PR-Agent address display-text fixback

Changing a structured address field now clears only that address's stale `text`; untouched addresses remain intact. The transport-backed component test exercises line, city, state, postal code and country independently, then reads both persisted Person and RelatedPerson. `address-text-green.txt`: 8 tests pass (5 guarantor UI + unchanged 3 demographicsConcurrency). Mutation: remove `text: undefined` from both structured-address update branches. `address-text-red.txt`: 1 failed because fresh persisted text remained `Old street, Synthetic city`. The mutation was restored before the final green run.


## Contact slot correction

A rendered clear-first-then-type reproduction proved that immediate blank filtering shifted the second home phone into the first slot. Draft contact slots now remain stable while typing. Only explicitly edited blank contacts are removed on Save; untouched valueless contacts are preserved. Edited-contact tracking resets when the draft refreshes after save, repair or reload.

`phone-slot-green.txt`: 10 tests pass (7 guarantor UI + unchanged 3 demographicsConcurrency). Both new tests read fresh persisted Person and RelatedPerson. Mutation restoring immediate blank filtering fails with the original first contact missing and second contact overwritten (`phone-slot-red.txt`). Mutation filtering every blank contact on Save fails because an untouched valueless email entry is removed (`phone-blank-red.txt`). Both were restored before final green.


## CodeRabbit per-patient write-status fixback

Each result now names the patient, verification classification, and update response status: accepted, conflict, failed, or response not received. A lost response can still be verified by the subsequent read; the response message does not override that evidence. A rendered transport-backed test rejects a child PUT in one run and persists it then loses the response in another, checking both the displayed status and fresh stored child. `write-status-green.txt`: 11 focused tests pass. Mutation suppressing non-conflict write-status rendering fails with the explicit failed-update message absent (`write-status-red.txt`); restored before final green.
