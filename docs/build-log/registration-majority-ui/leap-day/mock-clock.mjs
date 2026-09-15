import { mock } from "node:test";

mock.timers.enable({ apis: ["Date"], now: new Date(process.env.ODOS_MAJORITY_TEST_DATE).getTime() });
console.log(`Age-of-majority guard clock: ${new Date().toISOString()}`);
