import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type EvaluationDecision = {
  passed: boolean;
  reason: string;
  evaluator?: string;
  evaluatorLogin?: string;
  evaluatedHeadSha?: string;
  currentHeadSha?: string;
  verdict?: string;
  authorizedBy?: string;
  overrideReason?: string;
  message: string;
};

type EvaluationComment = {
  body: string;
  created_at: string;
  user: { login: string };
};

type EvaluationInput = {
  labels?: Array<{ name: string }>;
  comments?: EvaluationComment[];
  currentHeadSha?: string;
};

const CURRENT_HEAD = "a".repeat(40);
const PREVIOUS_HEAD = "b".repeat(40);
const TRUSTED_LOGIN = "odos-evaluator[bot]";
const require = createRequire(import.meta.url);
const { evaluateEvaluationGate } = require(
  "../../.github/scripts/evaluation-verdict.cjs",
) as {
  evaluateEvaluationGate(input?: EvaluationInput): EvaluationDecision;
};

function comment(
  body: string,
  createdAt = "2026-07-16T12:00:00Z",
  login = TRUSTED_LOGIN,
): EvaluationComment {
  return { body, created_at: createdAt, user: { login } };
}

function marker(
  evaluator: string,
  verdict: string,
  headSha = CURRENT_HEAD,
): string {
  return `Evaluated-by: ${evaluator} — ${verdict}\nHead-SHA: ${headSha}`;
}

function overrideMarker(headSha = CURRENT_HEAD): string {
  return `${marker("Eric Bang", "OVERRIDE", headSha)}\nOverride-Reason: Operator accepts the documented risk.`;
}

function evaluate(input: EvaluationInput = {}): EvaluationDecision {
  return evaluateEvaluationGate({
    currentHeadSha: CURRENT_HEAD,
    ...input,
  });
}

const repoRoot = new URL("../../", import.meta.url);

function workflowSource(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function triggerBlock(source: string): string {
  return source.match(/^on:\n([\s\S]*?)(?=^[a-z][a-z-]*:)/m)?.[1] ?? "";
}

function evaluationWorkflowScript(): string {
  const source = workflowSource(".github/workflows/evaluation-gate.yml");
  const marker = "          script: |\n";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "evaluation workflow needs an embedded script");
  return source
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
}

async function runEvaluationWorkflowScript(
  github: unknown,
  context: unknown,
  core: unknown,
  requireModule: (id: string) => unknown = require,
): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
  const execute = AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    "require",
    evaluationWorkflowScript(),
  ) as (...args: unknown[]) => Promise<void>;
  await execute(
    github,
    context,
    core,
    { env: { ...process.env, GITHUB_WORKSPACE: fileURLToPath(repoRoot) } },
    requireModule,
  );
}

type PublisherFault =
  | "pulls.get"
  | "checks.create"
  | "paginate"
  | "parser"
  | "checks.update"
  | "require";

function publisherHarness({
  fault,
  prNumber = 518,
}: {
  fault?: PublisherFault;
  prNumber?: number | null;
} = {}) {
  const faultError = new Error(`${fault ?? "publisher"} fault`);
  const checkUpdates: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const events: string[] = [];
  const github = {
    rest: {
      pulls: {
        get: async () => {
          if (fault === "pulls.get") throw faultError;
          return { data: { head: { sha: CURRENT_HEAD } } };
        },
      },
      checks: {
        create: async () => {
          if (fault === "checks.create") throw faultError;
          return { data: { id: 123 } };
        },
        update: async (input: Record<string, unknown>) => {
          if (fault === "checks.update") throw faultError;
          checkUpdates.push(input);
          events.push(`check:${String(input.conclusion)}`);
        },
      },
      issues: {
        listLabelsOnIssue: async () => ({ data: [] }),
        listComments: async () => ({ data: [] }),
      },
    },
    paginate: async () => {
      if (fault === "paginate") throw faultError;
      return [];
    },
  };
  const context = {
    payload: prNumber === null ? {} : { pull_request: { number: prNumber } },
    repo: { owner: "drbang-iva", repo: "ODOS2020" },
    runId: 33804575896,
  };
  const core = {
    info: () => undefined,
    warning: (message: string) => {
      warnings.push(message);
      events.push("warning");
    },
    setFailed: (message: string) => {
      failures.push(message);
      events.push("setFailed");
    },
  };
  const requireModule = fault === "require"
    ? () => { throw faultError; }
    : fault === "parser"
      ? () => ({ evaluateEvaluationGate: () => { throw faultError; } })
      : require;

  return {
    github,
    context,
    core,
    requireModule,
    faultError,
    checkUpdates,
    warnings,
    failures,
    events,
  };
}

test("a trusted Fable PASS bound to the current head passes", () => {
  const decision = evaluate({
    comments: [comment(marker("Fable 5", "PASS"))],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluator, "Fable 5");
  assert.equal(decision.evaluatorLogin, TRUSTED_LOGIN);
  assert.equal(decision.evaluatedHeadSha, CURRENT_HEAD);
  assert.equal(decision.verdict, "PASS");
});

test("bot-review evidence lines do not change marker parsing", () => {
  for (const evidence of [
    "greptile-apps[bot] via review submission",
    "github-actions (run pr-agent) via completed check run",
    "NONE (acknowledged)",
  ]) {
    const decision = evaluate({
      comments: [
        comment(`${marker("Opus 5", "PASS")}\nBot-review-at-head: ${evidence}`),
      ],
    });

    assert.equal(decision.passed, true, evidence);
    assert.equal(decision.reason, "passing-verdict", evidence);
  }
});

test("an explicit FAIL bound to the current head fails", () => {
  const decision = evaluate({
    comments: [comment(marker("Opus 4.8", "FAIL"))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.verdict, "FAIL");
});

test("a later trusted PASS supersedes an earlier trusted FAIL", () => {
  const decision = evaluate({
    comments: [
      comment(marker("Fable 5", "PASS"), "2026-07-16T13:00:00Z"),
      comment(marker("Opus 4.8", "FAIL"), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.evaluator, "Fable 5");
});

test("an earlier trusted PASS cannot rescue a later trusted FAIL", () => {
  const decision = evaluate({
    comments: [
      comment(marker("Fable 5", "FAIL"), "2026-07-16T13:00:00Z"),
      comment(marker("Opus 4.8", "PASS"), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.evaluator, "Fable 5");
});

test("a PASS for an earlier head is stale after a new commit", () => {
  const decision = evaluate({
    comments: [comment(marker("Opus 4.8", "PASS", PREVIOUS_HEAD))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "stale-head-sha");
  assert.equal(decision.evaluatedHeadSha, PREVIOUS_HEAD);
  assert.equal(decision.currentHeadSha, CURRENT_HEAD);
});

test("a marker without a head SHA fails", () => {
  const decision = evaluate({
    comments: [comment("Evaluated-by: Fable 5 — PASS")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-head-sha");
});

test("a marker with a short head SHA fails", () => {
  const decision = evaluate({
    comments: [comment("Evaluated-by: Fable 5 — PASS\nHead-SHA: abc123")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "invalid-head-sha");
});

test("duplicate evaluator or head lines fail as ambiguous", () => {
  const duplicateEvaluator = evaluate({
    comments: [
      comment(
        `${marker("Fable 5", "PASS")}\nEvaluated-by: Opus 4.8 — FAIL`,
      ),
    ],
  });
  const duplicateHead = evaluate({
    comments: [
      comment(`${marker("Fable 5", "PASS")}\nHead-SHA: ${CURRENT_HEAD}`),
    ],
  });

  assert.equal(duplicateEvaluator.reason, "ambiguous-marker");
  assert.equal(duplicateHead.reason, "ambiguous-head-sha");
});

test("a marker without a verdict token fails", () => {
  const decision = evaluate({
    comments: [comment(`Evaluated-by: Fable 5\nHead-SHA: ${CURRENT_HEAD}`)],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-verdict");
});

test("trailing or contradictory verdict content fails", () => {
  for (const trailing of ["PASS FAIL", "PASS — later changed to FAIL"]) {
    const decision = evaluate({
      comments: [
        comment(`Evaluated-by: Fable 5 — ${trailing}\nHead-SHA: ${CURRENT_HEAD}`),
      ],
    });

    assert.equal(decision.passed, false, trailing);
    assert.equal(decision.reason, "missing-verdict", trailing);
  }
});

test("Codex is a trusted evaluator and can issue the final verdict", () => {
  const decision = evaluate({
    comments: [comment(marker("Codex", "PASS"))],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.evaluator, "Codex");
});

test("Codex's versioned and GPT-qualified forms are trusted too", () => {
  for (const evaluator of ["Codex 5.6", "GPT-5.6 Codex", "Codex (GPT-5.6)"]) {
    const decision = evaluate({ comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, true, `${evaluator} should be trusted`);
    assert.equal(decision.evaluator, evaluator);
  }
});

test("Codex's actual gpt-5.6-sol signature passes without an override", () => {
  for (const evaluator of ["Codex (gpt-5.6-sol)", "CODEX (GPT-5.6-SOL)"]) {
    const decision = evaluate({ comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, true, evaluator);
    assert.equal(decision.reason, "passing-verdict");
    assert.equal(decision.evaluator, evaluator);
  }
});

const untrustedSignatures = [
  "Random Model 1",
  "Sonnet 5",
  "Gemini 3",
  "Codex (Random Model 1)",
  "Codex (gpt-5.6-terra)",
  "Codex (gpt-5.6-sol-extra)",
  "Codex (gpt-5.7-sol)",
  "Codex 5.6 (gpt-5.6-sol)",
  "GPT-5.6-sol Codex",
  "Fable 5.1 (gpt-5.6-sol)",
  "Opus 5 (gpt-5.6-sol)",
];

test("the sol exception does not admit Random Model 1 or arbitrary model suffixes", () => {
  for (const evaluator of untrustedSignatures) {
    const decision = evaluate({ comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, false, `${evaluator} must remain untrusted`);
    assert.equal(decision.reason, "untrusted-model", evaluator);
    assert.match(decision.message, /Fable.*Opus.*Codex/);
  }
});

test("the posting script and real gate agree on trusted signatures in a dry run", (t) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "odos-eval-signatures-"));
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
  writeFileSync(join(fixtureDirectory, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\\n' '${CURRENT_HEAD}'
  exit 0
fi
if [[ "$1 $2" == "api --paginate" ]]; then
  case "$3" in
    */comments) exit 0 ;;
    */reviews)
      printf '%s\\t%s\\t%s\\t%s\\n' COMMENTED '${CURRENT_HEAD}' '2026-07-16T12:00:00Z' 'greptile-apps[bot]'
      exit 0
      ;;
  esac
fi
echo "Unexpected GitHub call: $*" >&2
exit 99
`, { mode: 0o700 });

  const trustedSignatures = [
    "Fable 5.1",
    "Opus 5",
    "Claude Opus 5 (Claude)",
    "Codex",
    "Codex 5.6",
    "GPT-5.6 Codex",
    "Codex (GPT-5.6)",
    "Codex (gpt-5.6-sol)",
    "CODEX (GPT-5.6-SOL)",
  ];
  for (const evaluator of [...trustedSignatures, ...untrustedSignatures]) {
    const expectedPass = trustedSignatures.includes(evaluator);
    const result = spawnSync("bash", [
      fileURLToPath(new URL("scripts/eval-post-verdict.sh", repoRoot)),
      "506", "PASS", evaluator, "--dry-run",
    ], {
      cwd: fileURLToPath(repoRoot),
      env: {
        PATH: `${fixtureDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GH_REPO: "example/odos",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, expectedPass ? 0 : 1, `${evaluator}: ${result.stderr}`);
    if (expectedPass) {
      assert.match(result.stdout, /Dry run only; no comment will be posted\./);
      const postedMarker = result.stdout.match(/^Evaluated-by:.*\nHead-SHA:.*$/m)?.[0];
      assert.ok(postedMarker, `${evaluator}: dry run must emit a real marker`);
      const decision = evaluate({ comments: [comment(postedMarker)] });
      assert.equal(decision.passed, true, evaluator);
      assert.equal(decision.reason, "passing-verdict", evaluator);
      assert.equal(decision.evaluator, evaluator);
    } else {
      assert.match(result.stderr, /would be rejected by evaluation-verdict\.cjs/);
      const decision = evaluate({ comments: [comment(marker(evaluator, "PASS"))] });
      assert.equal(decision.passed, false, evaluator);
      assert.equal(decision.reason, "untrusted-model", evaluator);
    }
  }
});

// The allowlist must still EXCLUDE something, or it is not an allowlist. Sonnet is the live
// case: on 2026-09-01 a Sonnet verdict on PR #496 could not clear this gate, which is what
// sent that evaluation to Opus. Deleting this test would make the untrusted-model branch
// unreachable and the guard decorative.
test("an untrusted model still cannot issue the final verdict", () => {
  for (const evaluator of ["Sonnet 5", "Sonnet", "Gemini 3"]) {
    const decision = evaluate({ comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, false, `${evaluator} must not be trusted`);
    assert.equal(decision.reason, "untrusted-model");
  }
});

test("a marker posted under the PR author's login now passes", () => {
  const decision = evaluate({
    comments: [comment(marker("Fable 5", "PASS"), undefined, "pr-author")],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluatorLogin, "pr-author");
});

test("no evaluation marker fails", () => {
  const decision = evaluate({
    comments: [comment("Automated review complete.")],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "no-marker");
});

test("the evaluated label remains an explicit operator override only with its evidence", () => {
  const input = {
    labels: [{ name: "evaluated" }],
    comments: [comment(overrideMarker(), undefined, "drbang-iva")],
  };
  const decision = evaluate(input);

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "label-override");
  assert.equal(decision.authorizedBy, "Eric Bang");
  assert.equal(decision.overrideReason, "Operator accepts the documented risk.");
  assert.equal(decision.evaluatedHeadSha, CURRENT_HEAD);
  assert.equal(decision.verdict, "OVERRIDE");
  assert.match(decision.message, /Eric Bang/);
  assert.ok(decision.message.includes("Operator accepts the documented risk."));
  assert.ok(decision.message.includes(CURRENT_HEAD));

  const withoutComment = evaluate({ ...input, comments: [] });
  assert.equal(withoutComment.passed, false);
  assert.equal(withoutComment.reason, "missing-override-marker");
  assert.match(withoutComment.message, /Evaluated-by:.*OVERRIDE/);
  assert.match(withoutComment.message, /Head-SHA:/);
  assert.match(withoutComment.message, /Override-Reason:/);

  assert.equal(evaluate(input).passed, true);
});

test("an override for a stale head is refused even with its label and reason", () => {
  const decision = evaluate({
    labels: [{ name: "evaluated" }],
    comments: [comment(overrideMarker(PREVIOUS_HEAD))],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "stale-head-sha");
  assert.equal(decision.evaluatedHeadSha, PREVIOUS_HEAD);
  assert.equal(decision.currentHeadSha, CURRENT_HEAD);
  assert.match(decision.message, /OVERRIDE.*Head-SHA.*does not match/i);
  assert.ok(decision.message.includes(PREVIOUS_HEAD));
  assert.ok(decision.message.includes(CURRENT_HEAD));
});

test("an OVERRIDE posted after NEEDS-WORK deliberately wins", () => {
  const decision = evaluate({
    labels: [{ name: "evaluated" }],
    comments: [
      comment(overrideMarker(), "2026-07-16T13:00:00Z"),
      comment(marker("Opus 5", "NEEDS-WORK"), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "label-override");
  assert.equal(decision.authorizedBy, "Eric Bang");
});

test("an older override cannot rescue a newer NEEDS-WORK", () => {
  const decision = evaluate({
    labels: [{ name: "evaluated" }],
    comments: [
      comment(marker("Opus 5", "NEEDS-WORK"), "2026-07-16T13:00:00Z"),
      comment(overrideMarker(), "2026-07-16T12:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "failing-verdict");
  assert.equal(decision.verdict, "NEEDS-WORK");
});

test("removing the evaluated label disables an otherwise complete override", () => {
  const decision = evaluate({ comments: [comment(overrideMarker())] });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-override-label");
  assert.match(decision.message, /evaluated.*label.*missing/i);
});

test("an override records the typed name without authenticating the posting login", () => {
  for (const login of ["drbang-iva", "another-poster", "agent[bot]"]) {
    const decision = evaluate({
      labels: [{ name: "evaluated" }],
      comments: [comment(overrideMarker(), undefined, login)],
    });

    assert.equal(decision.passed, true, login);
    assert.equal(decision.authorizedBy, "Eric Bang", login);
  }
});

for (const { name, body, reason, message } of [
  {
    name: "missing OVERRIDE marker line",
    body: `Head-SHA: ${CURRENT_HEAD}\nOverride-Reason: Operator accepts the risk.`,
    reason: "missing-override-marker",
    message: /OVERRIDE MARKER MISSING/,
  },
  {
    name: "missing OVERRIDE verdict",
    body: `Evaluated-by: Eric Bang\nHead-SHA: ${CURRENT_HEAD}\nOverride-Reason: Operator accepts the risk.`,
    reason: "missing-verdict",
    message: /Evaluated-by:.*OVERRIDE/,
  },
  {
    name: "blank authorizer",
    body: `Evaluated-by:   — OVERRIDE\nHead-SHA: ${CURRENT_HEAD}\nOverride-Reason: Operator accepts the risk.`,
    reason: "missing-override-authorizer",
    message: /authoriz.*name.*missing/i,
  },
  {
    name: "missing Head-SHA line",
    body: "Evaluated-by: Eric Bang — OVERRIDE\nOverride-Reason: Operator accepts the risk.",
    reason: "missing-head-sha",
    message: /OVERRIDE HEAD SHA MISSING.*Head-SHA/,
  },
  {
    name: "short Head-SHA",
    body: overrideMarker("abc123"),
    reason: "invalid-head-sha",
    message: /OVERRIDE HEAD SHA INVALID.*40-character/,
  },
  {
    name: "duplicate Head-SHA lines",
    body: `${overrideMarker()}\nHead-SHA: ${PREVIOUS_HEAD}`,
    reason: "ambiguous-head-sha",
    message: /OVERRIDE HEAD SHA AMBIGUOUS/,
  },
  {
    name: "missing Override-Reason line",
    body: marker("Eric Bang", "OVERRIDE"),
    reason: "missing-override-reason",
    message: /nonempty Override-Reason/,
  },
  {
    name: "empty Override-Reason",
    body: `${marker("Eric Bang", "OVERRIDE")}\nOverride-Reason:`,
    reason: "missing-override-reason",
    message: /nonempty Override-Reason/,
  },
  {
    name: "whitespace-only Override-Reason followed by unrelated prose",
    body: `${marker("Eric Bang", "OVERRIDE")}\nOverride-Reason: \t\r\nUnrelated prose must not count as the reason.`,
    reason: "missing-override-reason",
    message: /nonempty Override-Reason/,
  },
  {
    name: "duplicate Override-Reason lines",
    body: `${overrideMarker()}\nOverride-Reason: Conflicting reason.`,
    reason: "ambiguous-override-reason",
    message: /more than one Override-Reason/,
  },
  {
    name: "duplicate Evaluated-by lines",
    body: `${overrideMarker()}\nEvaluated-by: Opus 5 — NEEDS-WORK`,
    reason: "ambiguous-marker",
    message: /exactly one 'Evaluated-by:'/,
  },
  {
    name: "contradictory OVERRIDE verdict",
    body: `${marker("Eric Bang", "OVERRIDE PASS")}\nOverride-Reason: Operator accepts the risk.`,
    reason: "missing-verdict",
    message: /Evaluated-by:.*OVERRIDE/,
  },
]) {
  test(`the evaluated label refuses ${name} with a precise diagnostic`, () => {
    const decision = evaluate({
      labels: [{ name: "evaluated" }],
      comments: [comment(body)],
    });

    assert.equal(decision.passed, false);
    assert.equal(decision.reason, reason);
    assert.match(decision.message, message);
    assert.match(decision.message, /Expected[\s\S]*Evaluated-by:.*OVERRIDE/);
  });
}

test("override evidence cannot be assembled across separate comments", () => {
  const decision = evaluate({
    labels: [{ name: "evaluated" }],
    comments: [
      comment("Override-Reason: Operator accepts the risk."),
      comment(marker("Eric Bang", "OVERRIDE")),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-override-reason");
});

test("a malformed newest override cannot fall back to older valid evidence", () => {
  const decision = evaluate({
    labels: [{ name: "evaluated" }],
    comments: [
      comment(overrideMarker(), "2026-07-16T12:00:00Z"),
      comment(marker("Eric Bang", "OVERRIDE"), "2026-07-16T13:00:00Z"),
    ],
  });

  assert.equal(decision.passed, false);
  assert.equal(decision.reason, "missing-override-reason");
});

test("the evaluated label does not change ordinary evaluation decisions", () => {
  for (const [evaluator, verdict, head, passed, reason] of [
    ["Opus 5", "PASS", CURRENT_HEAD, true, "passing-verdict"],
    ["Opus 5", "NEEDS-WORK", CURRENT_HEAD, false, "failing-verdict"],
    ["Fable 5", "PASS", PREVIOUS_HEAD, false, "stale-head-sha"],
    ["Sonnet 5", "PASS", CURRENT_HEAD, false, "untrusted-model"],
  ] as const) {
    const decision = evaluate({
      labels: [{ name: "evaluated" }],
      comments: [comment(marker(evaluator, verdict, head))],
    });

    assert.equal(decision.passed, passed);
    assert.equal(decision.reason, reason);
  }
});

test("override markers reuse separator and case normalization conventions", () => {
  for (const separator of ["—", "--", "-"]) {
    const decision = evaluate({
      labels: [{ name: "Evaluated" }],
      comments: [comment(
        `evaluated-by: Eric Bang ${separator} override\r\nhead-sha: ${CURRENT_HEAD.toUpperCase()}\r\noverride-reason:  Accepted risk.  `,
      )],
    });

    assert.equal(decision.passed, true, separator);
    assert.equal(decision.evaluatedHeadSha, CURRENT_HEAD);
    assert.equal(decision.overrideReason, "Accepted risk.");
  }
});

test("the evaluated label cannot bypass invalid current head input", () => {
  for (const currentHeadSha of ["", "abc123"]) {
    const decision = evaluate({
      currentHeadSha,
      labels: [{ name: "evaluated" }],
      comments: [comment(overrideMarker())],
    });

    assert.equal(decision.passed, false);
    assert.equal(decision.reason, "invalid-gate-input");
  }
});

test("em dash, double hyphen, and single hyphen separators pass", () => {
  for (const separator of ["—", "--", "-"]) {
    const decision = evaluate({
      comments: [
        comment(
          `Evaluated-by: Opus 4.8 ${separator} PASS\nHead-SHA: ${CURRENT_HEAD}`,
        ),
      ],
    });

    assert.equal(decision.passed, true, `separator ${separator}`);
  }
});

test("case normalization applies to verdicts, SHAs, and logins", () => {
  const decision = evaluate({
    comments: [
      comment(
        `Evaluated-by: opus 4.8 — pass\nHead-SHA: ${CURRENT_HEAD.toUpperCase()}`,
        undefined,
        "ODOS-EVALUATOR[BOT]",
      ),
    ],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.verdict, "PASS");
});

test("an invalid head SHA fails closed", () => {
  const invalidHead = evaluate({
    currentHeadSha: "abc123",
    comments: [comment(marker("Fable 5", "PASS"))],
  });

  assert.equal(invalidHead.reason, "invalid-gate-input");
});

test("evaluation-gate keeps every trigger and filters current or previous marker bodies", () => {
  const workflow = workflowSource(".github/workflows/evaluation-gate.yml");
  const triggers = triggerBlock(workflow);
  const parser = workflowSource(".github/scripts/evaluation-verdict.cjs");

  assert.match(
    triggers,
    /pull_request_target:\n\s+types: \[opened, synchronize, reopened, labeled, unlabeled\]\n\s+branches: \[main\]/,
  );
  assert.match(
    triggers,
    /issue_comment:\n\s+types: \[created, edited, deleted\]/,
  );
  assert.match(workflow, /github\.event_name == 'pull_request_target'/);
  assert.match(workflow, /contains\(github\.event\.comment\.body, 'Evaluated-by:'\)/);
  assert.match(
    workflow,
    /contains\(github\.event\.changes\.body\.from, 'Evaluated-by:'\)/,
  );

  const parserPrefix = parser.match(/const MARKER_PATTERN = \/\^([^/]+)\/im;/)?.[1];
  const workflowPrefixes = [
    ...workflow.matchAll(
      /contains\(github\.event\.(?:comment\.body|changes\.body\.from), '([^']+)'\)/g,
    ),
  ].map((match) => match[1]);
  assert.equal(parserPrefix, "Evaluated-by:");
  assert.deepEqual(workflowPrefixes, [parserPrefix, parserPrefix]);
});

test("an expected gate rejection completes the red check before warning without failing the publisher", async () => {
  const harness = publisherHarness();

  await runEvaluationWorkflowScript(
    harness.github,
    harness.context,
    harness.core,
    harness.requireModule,
  );

  assert.deepEqual(harness.failures, []);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0], /NOT EVALUATED/);
  assert.equal(harness.checkUpdates.length, 1);
  assert.equal(harness.checkUpdates[0].status, "completed");
  assert.equal(harness.checkUpdates[0].conclusion, "failure");
  assert.deepEqual(harness.events, ["check:failure", "warning"]);
});

test("publisher fails loudly when the PR number is unresolvable", async () => {
  const harness = publisherHarness({ prNumber: null });

  await runEvaluationWorkflowScript(
    harness.github,
    harness.context,
    harness.core,
    harness.requireModule,
  );

  assert.equal(harness.failures.length, 1);
  assert.match(harness.failures[0], /could not resolve a PR number/);
  assert.deepEqual(harness.events, ["setFailed"]);
});

for (const fault of [
  "pulls.get",
  "checks.create",
  "paginate",
  "parser",
  "checks.update",
  "require",
] as const) {
  test(`publisher fails loudly when ${fault} throws`, async () => {
    const harness = publisherHarness({ fault });

    await assert.rejects(
      () => runEvaluationWorkflowScript(
        harness.github,
        harness.context,
        harness.core,
        harness.requireModule,
      ),
      (error) => error === harness.faultError,
    );

    assert.deepEqual(harness.failures, []);
    assert.deepEqual(harness.warnings, []);
    if (fault === "paginate" || fault === "parser") {
      assert.equal(harness.checkUpdates.length, 1);
      assert.equal(harness.checkUpdates[0].conclusion, "failure");
    }
  });
}

test("PR-Agent runs only for the four automatic pull-request actions", () => {
  const workflow = workflowSource(".github/workflows/pr-agent.yml");
  const triggers = triggerBlock(workflow);

  assert.match(
    triggers,
    /pull_request:\n\s+branches: \[main\]\n\s+types: \[opened, reopened, ready_for_review, synchronize\]/,
  );
  assert.doesNotMatch(triggers, /issue_comment:/);
  assert.match(workflow, /if: github\.event\.sender\.type != 'Bot'/);
});

test("CI cancels superseded pull requests but never pushes to main", () => {
  const workflow = workflowSource(".github/workflows/ci.yml");

  assert.match(
    workflow,
    /^concurrency:\n\s+group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
  );
});

test("CI blocks on the focused real-Medplum preliminary Observation authorization proof", () => {
  const workflow = workflowSource(".github/workflows/ci.yml");
  const focusedStep = workflow.match(
    /- name: enforce preliminary Observation authorization on real Medplum\n(?<body>[\s\S]*?)\n\s+- name:/,
  )?.groups?.body;
  assert.ok(focusedStep, "CI needs a focused preliminary Observation authorization step");
  assert.doesNotMatch(focusedStep, /continue-on-error:/);
  assert.match(focusedStep, /ODOS_PRELIMINARY_OBSERVATION_AUTHZ_ONLY: "1"/);
  assert.match(focusedStep, /tests\/clinicalWriteAuthzLive\.test\.ts/);

  const liveTest = workflowSource("mcp/tests/clinicalWriteAuthzLive.test.ts");
  assert.match(
    liveTest,
    /if \(process\.env\.ODOS_PRELIMINARY_OBSERVATION_AUTHZ_ONLY === "1"\) \{\n\s+return;\n\s+\}/,
  );
});
