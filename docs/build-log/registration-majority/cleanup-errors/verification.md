# Preserve body and cleanup errors

Source change is confined to `ageOfMajorityAuthzLive.test.ts`: capture a body/setup failure, attempt both cleanup groups after the catch, then report the original and cleanup errors together. No throw remains in finally. Aggregate message includes nested messages so CI output exposes the failed cleanup resource/status.

Command from repository root: `node docs/build-log/registration-majority/cleanup-errors/callback-harness.cjs`.

The deterministic harness transpiles and executes the actual test callback with a synthetic body failure and HTTP 403 cleanup failures. It asserts that the AggregateError retains both. Removing the actual body-error capture causes the original-error assertion to fail; restoring capture passes. Exact output: `mutation.txt`.

This harness proves error preservation only. The route/identity cleanup fix is implemented and its exact composite-caller live red/green proof is recorded in [administrative cleanup verification](../admin-cleanup/verification.md). Final-head CI is a separate gate tracked on [PR #607](https://github.com/drbang-iva/ODOS2020/pull/607).
