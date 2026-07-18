import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatementMessageConfigResource,
  parseStatementMessageConfig,
} from "../src/statements/statement-message-config.js";

test("statement-message config round-trips both independent fields and preserves Basic identity", () => {
  const existing = {
    resourceType: "Basic" as const,
    id: "statement-message-config-1",
    meta: { versionId: "7" },
    code: { text: "old" },
  };
  const config = {
    statementFooterMessage: "Balances over 90 days may be sent to collections.",
    receiptFooterMessage: "Thank you for trusting our practice.",
  };
  const built = buildStatementMessageConfigResource(config, existing);
  assert.equal(built.id, existing.id);
  assert.deepEqual(built.meta, existing.meta);
  assert.deepEqual(parseStatementMessageConfig(built), config);
});

test("statement-message config treats empty fields as unset", () => {
  const built = buildStatementMessageConfigResource({
    statementFooterMessage: "",
    receiptFooterMessage: "",
  });
  assert.deepEqual(parseStatementMessageConfig(built), {});
});

test("statement-message config rejects either field above 320 characters", () => {
  assert.throws(
    () => buildStatementMessageConfigResource({ statementFooterMessage: "s".repeat(321) }),
    { message: "Statement footer message must be 320 characters or fewer." },
  );
  assert.throws(
    () => buildStatementMessageConfigResource({ receiptFooterMessage: "r".repeat(321) }),
    { message: "Receipt footer message must be 320 characters or fewer." },
  );
});
