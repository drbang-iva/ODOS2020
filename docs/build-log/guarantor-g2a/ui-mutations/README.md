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
