# CL-A UI author evidence

Base: `6a3ad04abf623d4e2602b0239a658c575c43827f`. Branch: `drbang-iva/cleanup-a-ui`.

Implemented A4, A6, A7, A8. `/desk/whoami` must supply effective `businessActions`; missing actions fail closed. Last-update age is labelled honestly because creation time is not supplied by the contract.

Executed from `ui/`:

- `node --import tsx --test tests/guarantorSearchScreens.test.tsx tests/unusedGuarantorsSettings.test.tsx`: 27 passed, 0 failed, both green and restored.
- O8: removed discard call: 2 failed; U1: removed selected textable value: 1 failed; U2: removed search key reset: 1 failed. Exact mutation and output in each red file. All restored before final run.
- `node --import tsx --test tests/practiceSettings.test.tsx tests/guarantorAttachChart.test.tsx tests/guarantorPhoneForm.test.tsx tests/guarantorRecoveryFixback.test.tsx tests/guarantorLinkOperations.test.tsx tests/roleRouting.test.tsx tests/loginDeskHome.test.tsx`: 81 passed, 0 failed.
- `npx tsc --noEmit --skipLibCheck`: exit 0, no output.

U1 uses the real demographic writer and JSON-roundtripped output. Request/response fixtures cross JSON boundaries. O8 here proves the exact discard request, reason and retained creation version, plus refusal retaining the preview. Actual persisted Person deactivation requires the backend/live O8 lane in the parent task. No browser screenshot or live Medplum proof is claimed here.

NOT EVALUATED. Author-side evidence only; separate Claude Opus evaluates the integrated exact head.
