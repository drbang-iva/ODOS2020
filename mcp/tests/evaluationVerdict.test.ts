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
  prBody?: string;
  prAuthorType?: string;
};

type CoderCase = {
  id?: string;
  evaluator: string;
  prBody: string;
  reason: string;
  prAuthorType?: string;
  verdict?: string;
  head?: string;
  labels?: Array<{ name: string }>;
};

const CURRENT_HEAD = "a".repeat(40);
const PREVIOUS_HEAD = "b".repeat(40);
const TRUSTED_LOGIN = "odos-evaluator[bot]";
const require = createRequire(import.meta.url);
const { evaluateEvaluationGate, evaluatorTool } = require(
  "../../.github/scripts/evaluation-verdict.cjs",
) as {
  evaluateEvaluationGate(input?: EvaluationInput): EvaluationDecision;
  evaluatorTool(signature: string): "codex" | "claude" | undefined;
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
    prBody: "Coded-by: Codex",
    prAuthorType: "User",
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
  prBody = "Coded-by: Codex",
  prAuthorType = "User",
  comments = [],
}: {
  fault?: PublisherFault;
  prNumber?: number | null;
  prBody?: string;
  prAuthorType?: string;
  comments?: EvaluationComment[];
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
          return { data: { head: { sha: CURRENT_HEAD }, body: prBody, user: { type: prAuthorType } } };
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
      return comments;
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
    prBody: "Coded-by: Claude",
    comments: [comment(marker("Codex", "PASS"))],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.evaluator, "Codex");
});

test("Astra is a trusted evaluator and can issue the final verdict", () => {
  const decision = evaluate({
    prBody: "Coded-by: Claude",
    comments: [comment(marker("Astra", "PASS"))],
  });

  assert.equal(decision.passed, true);
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.evaluator, "Astra");
  assert.equal(decision.evaluatedHeadSha, CURRENT_HEAD);
  assert.equal(decision.verdict, "PASS");
});

test("Codex's versioned and GPT-qualified forms are trusted too", () => {
  for (const evaluator of ["Codex 5.6", "GPT-5.6 Codex", "Codex (GPT-5.6)"]) {
    const decision = evaluate({ prBody: "Coded-by: Claude", comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, true, `${evaluator} should be trusted`);
    assert.equal(decision.evaluator, evaluator);
  }
});

test("Codex's actual gpt-5.6-sol signature passes without an override", () => {
  for (const evaluator of ["Codex (gpt-5.6-sol)", "CODEX (GPT-5.6-SOL)"]) {
    const decision = evaluate({ prBody: "Coded-by: Claude", comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.passed, true, evaluator);
    assert.equal(decision.reason, "passing-verdict");
    assert.equal(decision.evaluator, evaluator);
  }
});

const untrustedSignatures = [
  "Random Model 1",
  "GPT-5.6 Terra",
  "Terra",
  "Sonnet 5",
  "Sonnet",
  "Gemini 3",
  "Gemini",
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

test("S17 G14 the posting script and real gate agree on signatures and coder checks in a dry run", (t) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "odos-eval-signatures-"));
  t.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
  writeFileSync(join(fixtureDirectory, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "api repos/example/odos/pulls/506" ]]; then
  printf '%s\\n' "$FIXTURE_PR_JSON"
  exit 0
fi
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\\n' '${CURRENT_HEAD}'
  exit 0
fi
if [[ "$1 $2" == "api --paginate" ]]; then
  case "$3" in
    */comments) exit 0 ;;
    */reviews)
      printf '%s\\t%s\\t%s\\t%s\\n' COMMENTED '${CURRENT_HEAD}' '2026-07-16T12:00:00Z' 'coderabbitai[bot]'
      exit 0
      ;;
  esac
fi
echo "Unexpected GitHub call: $*" >&2
exit 99
`, { mode: 0o700 });

  const trustedSignatures = [
    "Astra", "Fable", "Fable 5", "Fable 5.1", "Opus", "Opus 5",
    "Claude Opus 5", "Claude Opus 5 (Claude)", "Codex", "Codex 5.6",
    "GPT-5.6 Codex", "Codex (GPT-5.6)", "Codex (gpt-5.6-sol)", "CODEX (GPT-5.6-SOL)",
  ];
  const cases: CoderCase[] = [
    { evaluator: "Opus 5", prBody: "Coded-by: Codex/Claude", reason: "same-tool-evaluator" },
    { evaluator: "Codex (GPT-6)", prBody: "<!--\nCoded-by: Claude\n-->", reason: "missing-coded-by" },
    { evaluator: "Opus 5", prBody: "Coded-by: Codex — GPT-6 Astra (high); helper GPT-5.6 Sol", reason: "passing-verdict" },
    ...trustedSignatures.map((evaluator) => ({
      evaluator,
      prBody: /Fable|Opus/.test(evaluator) ? "Coded-by: Codex" : "Coded-by: Claude",
      reason: "passing-verdict",
    })),
    ...untrustedSignatures.map((evaluator) => ({
      evaluator, prBody: "Coded-by: Codex", reason: "untrusted-model",
    })),
    { evaluator: "Codex", prBody: "Coded-by: Codex", reason: "same-tool-evaluator" },
    { evaluator: "Opus 5", prBody: "Coded-by: Claude", reason: "same-tool-evaluator" },
    { evaluator: "Opus 5", prBody: "", reason: "missing-coded-by" },
    { evaluator: "Opus 5", prBody: "Coded-by: <Codex | Claude> — <model, effort>", reason: "unrecognized-coded-by" },
    { evaluator: "Opus (GPT-6)", prBody: "Coded-by: Codex", reason: "ambiguous-evaluator-tool" },
    { evaluator: "Codex", prBody: "", prAuthorType: "Bot", reason: "passing-verdict" },
    { evaluator: "Codex", prBody: "", verdict: "FAIL", reason: "failing-verdict" },
  ];
  for (const { evaluator, prBody, prAuthorType = "User", verdict = "PASS", reason } of cases) {
    const result = spawnSync("bash", [
      fileURLToPath(new URL("scripts/eval-post-verdict.sh", repoRoot)),
      "506", verdict, evaluator, "--dry-run",
    ], {
      cwd: fileURLToPath(repoRoot),
      env: {
        PATH: `${fixtureDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
        GH_REPO: "example/odos",
        FIXTURE_PR_JSON: JSON.stringify({ head: { sha: CURRENT_HEAD }, body: prBody, user: { type: prAuthorType } }),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    const decision = evaluate({ prBody, prAuthorType, comments: [comment(marker(evaluator, verdict))] });
    const accepted = reason === "passing-verdict" || verdict === "FAIL";
    assert.equal(decision.reason, reason, evaluator);
    assert.equal(result.status, accepted ? 0 : 1, `${evaluator} (${reason}): ${result.stderr}`);
    if (accepted) {
      assert.match(result.stdout, /Dry run only; no comment will be posted\./);
      const postedMarker = result.stdout.match(/^Evaluated-by:.*\nHead-SHA:.*$/m)?.[0];
      assert.ok(postedMarker, `${evaluator}: dry run must emit a real marker`);
      assert.equal(evaluate({ prBody, prAuthorType, comments: [comment(postedMarker)] }).reason, reason);
    } else {
      assert.ok(result.stderr.includes(decision.message), `${reason}: script must report the gate's message`);
      assert.doesNotMatch(result.stdout, /Dry run only|^Evaluated-by:/m);
    }
  }
});

// The allowlist must still EXCLUDE something, or it is not an allowlist. Sonnet is the live
// case: on 2026-09-01 a Sonnet verdict on PR #496 could not clear this gate, which is what
// sent that evaluation to Opus. Deleting this test would make the untrusted-model branch
// unreachable and the guard decorative.
test("an untrusted model still cannot issue the final verdict", () => {
  for (const evaluator of ["GPT-5.6 Terra", "Terra", "Sonnet 5", "Sonnet", "Gemini 3", "Gemini"]) {
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
    /pull_request_target:\n\s+types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]\n\s+branches: \[main\]/,
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

test("CI blocks on the complete live authorization lane after policy sync", () => {
  const workflow = workflowSource(".github/workflows/ci.yml");
  const integrationStep = workflow.match(
    /- name: run credentialed live integration lane\n(?<body>[\s\S]*?)\n\s+- name:/,
  )?.groups?.body;
  assert.ok(integrationStep, "CI needs the blocking live integration lane");
  assert.match(
    integrationStep,
    /ODOS_POSTGRES_URL: postgresql:\/\/medplum:medplum@127\.0\.0\.1:15432\/medplum/,
  );

  const authorizationStep = workflow.match(
    /- name: run credentialed live authorization lane\n(?<body>[\s\S]*?)\n\s+- name:/,
  )?.groups?.body;
  assert.ok(authorizationStep, "CI needs the blocking live authorization lane");
  assert.doesNotMatch(authorizationStep, /continue-on-error:/);
  assert.match(authorizationStep, /source \.\.\/\.odos\/operator\.env/);
  assert.match(authorizationStep, /npm run test:live-authz/);
  assert.ok(
    workflow.indexOf("- name: sync canonical practice-role policies for live authorization lane")
      < workflow.indexOf("- name: run credentialed live authorization lane"),
    "CI must sync practice-role policy before running authorization assertions",
  );

  const packageJson = JSON.parse(workflowSource("mcp/package.json")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts["test:live-authz"], /tests\/clinicalWriteAuthzLive\.test\.ts/);
  assert.match(packageJson.scripts["test:live-authz"], /tests\/encounterUndoLedgerAuthzLive\.test\.ts/);
  assert.match(packageJson.scripts["test:live-authz"], /tests\/v05a-authz\.test\.ts/);
  const liveTest = workflowSource("mcp/tests/clinicalWriteAuthzLive.test.ts");
  assert.match(
    liveTest,
    /if \(process\.env\.ODOS_PRELIMINARY_OBSERVATION_AUTHZ_ONLY === "1"\) \{\n\s+return;\n\s+\}/,
  );
});


const coderCases: CoderCase[] = [
  { id: "S1", evaluator: "Codex (GPT-6)", prBody: "Coded-by: Codex", reason: "same-tool-evaluator" },
  { id: "S2", evaluator: "Astra", prBody: "Coded-by: Codex", reason: "same-tool-evaluator" },
  { id: "S3", evaluator: "Codex (gpt-5.6-sol)", prBody: "Coded-by: Codex", reason: "same-tool-evaluator" },
  { id: "S4", evaluator: "Opus 5", prBody: "Coded-by: Codex, GPT-6 Astra", reason: "passing-verdict" },
  { id: "S5", evaluator: "Opus 5", prBody: "Coded-by: Claude — Opus 5", reason: "same-tool-evaluator" },
  { id: "S6", evaluator: "Codex", prBody: "Coded-by: Claude", reason: "passing-verdict" },
  ...["Codex", "Opus 5"].map((evaluator) => ({ id: "S7", evaluator, prBody: "Coded-by: Codex\nCoded-by: Claude", reason: "same-tool-evaluator" })),
  { id: "S8", evaluator: "Opus 5", prBody: "", reason: "missing-coded-by" },
  { id: "S9", evaluator: "Opus 5", prBody: "```text\nCoded-by: Codex\n```", reason: "missing-coded-by" },
  { id: "S10", evaluator: "Opus 5", prBody: "Coded-by: <Codex | Claude> — <model, effort>", reason: "unrecognized-coded-by" },
  { id: "S11", evaluator: "Opus (GPT-6)", prBody: "Coded-by: Codex", reason: "ambiguous-evaluator-tool" },
  { id: "S12", evaluator: "Codex", prBody: "", prAuthorType: "Bot", reason: "passing-verdict" },
  { id: "S13", evaluator: "Codex", prBody: "Coded-by: Codex", verdict: "OVERRIDE", labels: [{ name: "evaluated" }], reason: "label-override" },
  { id: "S14", evaluator: "Codex", prBody: "", verdict: "OVERRIDE", labels: [{ name: "evaluated" }], reason: "label-override" },
  { id: "S15", evaluator: "Codex", prBody: "Coded-by: Codex", verdict: "NEEDS-WORK", reason: "failing-verdict" },
  { id: "S16", evaluator: "Opus 5", prBody: "Coded-by: Codex", head: PREVIOUS_HEAD, reason: "stale-head-sha" },
  { id: "S16 stale same-tool companion", evaluator: "Codex", prBody: "Coded-by: Codex", head: PREVIOUS_HEAD, reason: "stale-head-sha" },
];
for (const { id, evaluator, prBody, reason, prAuthorType = "User", verdict = "PASS", head = CURRENT_HEAD, labels = [] } of coderCases) {
  test(`${id} ${evaluator} returns ${reason}`, () => {
    const body = verdict === "OVERRIDE" ? overrideMarker(head) : marker(evaluator, verdict, head);
    const decision = evaluate({ prBody, prAuthorType, labels, comments: [comment(body)] });
    assert.equal(decision.reason, reason);
    assert.equal(decision.passed, reason === "passing-verdict" || reason === "label-override");
    if (reason === "same-tool-evaluator") {
      assert.ok(decision.message.includes(evaluator));
      assert.match(decision.message, /Coded-by: (Codex|Claude)/);
      assert.match(decision.message, /cannot evaluate.*operator OVERRIDE/);
      if (id === "S7") assert.match(decision.message, /both Codex and Claude/);
      else assert.match(decision.message, /get a (Claude|Codex) evaluation/);
    }
  });
}

test("S3 token-only companion classifies every whole-word alias without widening model trust", () => {
  for (const token of ["Codex", "GPT", "Astra", "Sol"]) {
    assert.equal(evaluatorTool(token), "codex", token);
    assert.equal(evaluatorTool(token.toLowerCase()), "codex", token);
  }
  for (const token of ["Claude", "Opus", "Fable"]) {
    assert.equal(evaluatorTool(token), "claude", token);
  }
  for (const token of ["Unknown", "Solstice", "Astral", "Opuses", "Codex (Claude)", "Opus (GPT-6)"]) {
    assert.equal(evaluatorTool(token), undefined, token);
  }
  assert.equal(evaluate({ comments: [comment(marker("Sol", "PASS"))] }).reason, "untrusted-model");
});

test("coder declarations ignore fenced examples and count all named tools", () => {
  assert.equal(evaluate({
    prBody: "~~~text\nCoded-by: Claude\n~~~\nCoDeD-bY: cOdEx — helper Opus 5",
    comments: [comment(marker("Opus 5", "PASS"))],
  }).reason, "same-tool-evaluator");
  for (const prBody of [

    "````text\nCoded-by: Claude\n```\nCoded-by: Claude\n````\nCoded-by: Codex",
    "   ~~~text\nCoded-by: Claude\n```\nCoded-by: Claude\n   ~~~~\nCoded-by: Codex",
    "Coded-by: Codex\nCoded-by: Codex, GPT-6 Astra",
    "Coded-by: Codex\r\n```text\r\nCoded-by: Claude\r\n```",
  ]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "passing-verdict", prBody);
  }
  for (const prBody of ["~~~\nCoded-by: Codex\n~~~", "```\nCoded-by: Codex", "Some Coded-by: Codex"]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "missing-coded-by", prBody);
  }
  for (const prBody of ["Coded-by: Codexish", "Coded-by: ClaudeCode", "Coded-by: Human\nCoded-by: Codex"]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "unrecognized-coded-by", prBody);
  }
});

test("the actual PR template fails closed until its coder placeholder is edited", () => {
  const decision = evaluate({
    prBody: workflowSource(".github/pull_request_template.md"),
    comments: [comment(marker("Opus 5", "PASS"))],
  });
  assert.equal(decision.reason, "unrecognized-coded-by");
});

test("existing failure reasons win even when the coder declaration is missing", () => {
  for (const [body, reason] of [
    [marker("Codex", "FAIL"), "failing-verdict"],
    [marker("Codex", "BLOCKED"), "failing-verdict"],
    [marker("Sonnet", "PASS"), "untrusted-model"],
    [marker("Opus 5", "PASS", PREVIOUS_HEAD), "stale-head-sha"],
    ["Evaluated-by: Opus 5 — PASS", "missing-head-sha"],
    ["Evaluated-by: Opus 5", "missing-verdict"],
  ]) {
    assert.equal(evaluate({ prBody: "", comments: [comment(body)] }).reason, reason);
  }
});

test("the workflow uses the fetched PR body and author type with the real parser", async () => {
  for (const [prBody, prAuthorType, evaluator, conclusion, message] of [
    ["Coded-by: Claude", "User", "Codex", "success", "gate passes"],
    ["Coded-by: Codex", "User", "Codex", "failure", "cannot evaluate"],
    ["", "User", "Codex", "failure", "CODED-BY MISSING"],
    ["", "Bot", "Codex", "success", "gate passes"],
  ]) {
    const harness = publisherHarness({ prBody, prAuthorType, comments: [comment(marker(evaluator, "PASS"))] });
    await runEvaluationWorkflowScript(harness.github, harness.context, harness.core);
    assert.equal(harness.checkUpdates[0].conclusion, conclusion);
    const output = harness.checkUpdates[0].output as { summary: string };
    assert.ok(output.summary.includes(message), output.summary);
  }
});

test("evaluation workflow checks out only the default branch without persisted credentials", () => {
  const workflow = workflowSource(".github/workflows/evaluation-gate.yml");
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref:.*(?:head|pull_request)/);
});

for (const { id, prBody, evaluator, reason } of [
  { id: "G1", prBody: "Coded-by: Codex/Claude", evaluator: "Opus 5", reason: "same-tool-evaluator" },
  { id: "G2", prBody: "Coded-by: Codex + Claude", evaluator: "Codex (GPT-6)", reason: "same-tool-evaluator" },
  { id: "G5", prBody: "Coded-by: Codex — from Claude's contract", evaluator: "Opus 5", reason: "same-tool-evaluator" },
  { id: "G6", prBody: "<!--\nCoded-by: Claude\n-->", evaluator: "Codex (GPT-6)", reason: "missing-coded-by" },
  { id: "G7", prBody: "<!--\nCoded-by: Codex", evaluator: "Opus 5", reason: "missing-coded-by" },
  { id: "G9", prBody: "Coded-by: Codex <!-- Claude -->", evaluator: "Opus 5", reason: "passing-verdict" },
]) {
  test(`${id} coded-by fixback`, () => {
    const decision = evaluate({ prBody, comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.reason, reason);
    assert.equal(decision.passed, reason === "passing-verdict");
    if (id === "G2") assert.match(decision.message, /both Codex and Claude are declared/);
  });
}

for (const { id, prBody, evaluator = "Opus 5", reason = "passing-verdict" } of [
  { id: "G3", prBody: "Coded-by: Codex — GPT-6 Astra (high); helper GPT-5.6 Sol" },
  { id: "G4 cross-tool", prBody: "Coded-by: Claude — Sonnet 5", evaluator: "Codex" },
  { id: "G4 same-tool", prBody: "Coded-by: Claude — Sonnet 5", reason: "same-tool-evaluator" },
  { id: "G4 Sonnet token companion", prBody: "Coded-by: Codex — Sonnet 5", reason: "same-tool-evaluator" },
  { id: "G8", prBody: "<!-- note -->\nCoded-by: Codex" },
  { id: "G8 closing-line companion", prBody: "<!--\nnote -->\nCoded-by: Codex" },
  { id: "G10", prBody: "```text\n<!--\n```\nCoded-by: Codex" },
  { id: "G11", prBody: "<!--\nCoded-by: Claude\n-->\nCoded-by: Codex" },
  { id: "G11 fence inside active comment", prBody: "<!--\n```\n-->\nCoded-by: Codex" },
  { id: "G15", prBody: "Coded-by: Codex", evaluator: "Sonnet 5", reason: "untrusted-model" },
]) {
  test(`${id} coded-by fixback`, () => {
    const decision = evaluate({ prBody, comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.reason, reason);
    assert.equal(decision.passed, reason === "passing-verdict");
  });
}

test("G12 real merged PR template refuses the placeholder", () => {
  const prBody = readFileSync(new URL("mcp/tests/fixtures/evaluation-pr-template-614.md", repoRoot), "utf8");
  assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "unrecognized-coded-by");
});

test("G13 real PR 614 body preserves tool independence", () => {
  const prBody = readFileSync(new URL("mcp/tests/fixtures/evaluation-pr-614.md", repoRoot), "utf8");
  for (const [evaluator, reason] of [["Opus 5", "passing-verdict"], ["Codex (GPT-6)", "same-tool-evaluator"]]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker(evaluator, "PASS"))] }).reason, reason);
  }
});

test("G4 shared token table recognizes whole words in coder values and signatures", () => {
  for (const [tool, tokens, evaluator] of [
    ["codex", ["Codex", "GPT", "Astra", "Sol"], "Codex"],
    ["claude", ["Claude", "Opus", "Fable", "Sonnet", "Haiku"], "Opus 5"],
  ] as const) {
    for (const token of tokens) {
      assert.equal(evaluatorTool(token.toLowerCase()), tool);
      const prBody = `Coded-by: ${tool === "codex" ? "Claude" : "Codex"} — ${token.toLowerCase()}`;
      assert.equal(evaluate({ prBody, comments: [comment(marker(evaluator, "PASS"))] }).reason, "same-tool-evaluator");
    }
  }
  for (const suffix of ["Astral Solstice", "Opuses Sonneteer Haikus", "ClaudeCode Codexish"]) {
    assert.equal(evaluate({ prBody: `Coded-by: Codex — ${suffix}`, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "passing-verdict");
  }
});

test("F2 strips all inline spans and keeps only text before an unclosed comment", () => {
  for (const prBody of [
    "Coded-by: Codex <!-- Claude --> GPT <!-- Haiku --> Astra",
    "Coded-by: Codex <!<!-- note -->-- Claude",
    "Coded-by: Codex <!-- unclosed\nCoded-by: Claude",
    "<!--\nnote --> Coded-by: Claude\nCoded-by: Codex",
  ]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "passing-verdict");
  }
  for (const prBody of ["<!--\n--> Coded-by: Codex", "<!--\n-->Coded-by: Codex"]) {
    assert.equal(evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason, "missing-coded-by");
  }
});

for (const { id, prBody, evaluator, reason } of [
  { id: "G16", prBody: "Coded-by: Claude <!-- a --> <!-- b -->\nCoded-by: Codex", evaluator: "Codex (GPT-6)", reason: "same-tool-evaluator" },
  { id: "G17", prBody: "<!--\n--> <!--\nCoded-by: Claude\n-->", evaluator: "Codex (GPT-6)", reason: "missing-coded-by" },
  { id: "G18", prBody: "<!--\n--> <!-- x -->\nCoded-by: Codex", evaluator: "Opus 5", reason: "passing-verdict" },
]) {
  test(`${id} rev 2 comment state`, () => {
    const decision = evaluate({ prBody, comments: [comment(marker(evaluator, "PASS"))] });
    assert.equal(decision.reason, reason);
    assert.equal(decision.passed, reason === "passing-verdict");
  });
}

test("G19 GitHub GFM renders Codex visible and Claude inside the code block", () => {
  const prBody = "<!--\n```-->\nCoded-by: Codex\n```\nCoded-by: Claude\n```";
  const decision = evaluate({ prBody, comments: [comment(marker("Codex (GPT-6)", "PASS"))] });
  assert.equal(decision.reason, "same-tool-evaluator");
  assert.equal(decision.passed, false);
});

test("V1 Grok coder accepts trusted Claude and Codex evaluations", () => {
  for (const evaluator of ["Opus 5", "Codex (GPT-6)"]) {
    const decision = evaluate({
      prBody: "Coded-by: Grok — grok-4.7, high effort",
      comments: [comment(marker(evaluator, "PASS"))],
    });
    assert.equal(decision.reason, "passing-verdict", evaluator);
    assert.equal(decision.passed, true, evaluator);
  }
});

test("V2 Grok coder recognition requires a whole-word tool name", () => {
  for (const coder of ["Grokish", "GrokCode"]) {
    const decision = evaluate({
      prBody: `Coded-by: ${coder}`,
      comments: [comment(marker("Opus 5", "PASS"))],
    });
    assert.equal(decision.reason, "unrecognized-coded-by", coder);
    assert.equal(decision.passed, false, coder);
  }
});

test("V3 Grok remains excluded from the trusted evaluator allowlist", () => {
  const decision = evaluate({
    prBody: "Coded-by: Codex — GPT-6 Sol, medium effort",
    comments: [comment(marker("Grok 4.7", "PASS"))],
  });
  assert.equal(decision.reason, "untrusted-model");
  assert.equal(decision.passed, false);
});

test("V4 multi-coder message names the declared Claude and Grok tools", () => {
  const mixedDecision = evaluate({
    prBody: "Coded-by: Claude — Sonnet 5\nCoded-by: Grok — grok-4.7",
    comments: [comment(marker("Opus 5", "PASS"))],
  });
  assert.equal(mixedDecision.reason, "same-tool-evaluator");
  assert.match(mixedDecision.message, /both Claude and Grok are declared coders/);
  assert.match(mixedDecision.message, /get an evaluation from a tool that is not declared as a coder/);
  assert.doesNotMatch(mixedDecision.message, /Codex/);

  const reversedLegacyDecision = evaluate({
    prBody: "Coded-by: Claude — Sonnet 5\nCoded-by: Codex — GPT-6 Sol",
    comments: [comment(marker("Opus 5", "PASS"))],
  });
  assert.equal(reversedLegacyDecision.reason, "same-tool-evaluator");
  assert.match(reversedLegacyDecision.message, /both Codex and Claude are declared coders/);
  assert.match(reversedLegacyDecision.message, /only an operator OVERRIDE can pass/);
});

test("V5 Grok-only coding remains independent from a Claude evaluation", () => {
  const decision = evaluate({
    prBody: "Coded-by: Grok — grok-4.7, high effort",
    comments: [comment(marker("Opus 5", "PASS"))],
  });
  assert.equal(decision.reason, "passing-verdict");
  assert.equal(decision.passed, true);
});

test("V6 edited PR template keeps its Grok-inclusive placeholder fail-closed", () => {
  const prBody = workflowSource(".github/pull_request_template.md");
  assert.match(prBody, /^Coded-by: <Codex \| Claude \| Grok> — <model, effort>$/m);
  assert.equal(
    evaluate({ prBody, comments: [comment(marker("Opus 5", "PASS"))] }).reason,
    "unrecognized-coded-by",
  );
});
