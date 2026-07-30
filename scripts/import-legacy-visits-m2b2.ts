#!/usr/bin/env tsx
import {
  runVisitImportCommand,
  runVisitImportCli,
} from "./import-legacy-visits-m2b1.js";

export { runVisitImportCli };

if (import.meta.url === `file://${process.argv[1]}`) {
  await runVisitImportCommand({
    args: process.argv.slice(2),
    label: "M2B2",
    runPrefix: "m2b2",
  });
}
