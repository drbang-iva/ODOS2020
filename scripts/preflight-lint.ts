#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Resource } from "@medplum/fhirtypes";
import { buildOsodAuditEventRow, type OsodAuditEventRecord } from "../mcp/src/authz/osodAudit.js";
import { smartScopeLintVerdict } from "../mcp/src/smart/scope.js";
import { findPhiPatternMatches, type PreflightPhiMatch } from "../policy/preflight-phi-patterns.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = resolve(REPO_ROOT, ".osod");

export type PreflightSeverity = "warning" | "hard-block";
export type PreflightPassStatus = "pass" | "warning" | "hard-block";

export interface PreflightFinding {
  readonly pass: "logs" | "resource-names" | "env-vars" | "vendor-canonical-shapes";
  readonly severity: PreflightSeverity;
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ledgerRow?: number;
  readonly lesson?: string;
}

export interface PreflightPassReport {
  readonly id: PreflightFinding["pass"];
  readonly status: PreflightPassStatus;
  readonly findings: readonly PreflightFinding[];
}

export interface PreflightReport {
  readonly generatedAt: string;
  readonly summary: {
    readonly warnings: number;
    readonly hardBlocks: number;
  };
  readonly passes: readonly PreflightPassReport[];
  readonly auditRows: readonly OsodAuditEventRecord[];
}

export interface LogScrubPassOptions {
  readonly logText?: string;
  readonly source?: string;
}

export interface ResourceNamePassOptions {
  readonly resources?: readonly ResourceNameLintResource[];
}

export interface EnvVarPhiPassOptions {
  readonly env?: Record<string, string | undefined>;
}

export interface VendorCanonicalShapePassOptions {
  readonly roots?: readonly string[];
  readonly files?: readonly { path: string; text: string }[];
}

export interface RunPreflightOptions extends LogScrubPassOptions, ResourceNamePassOptions, EnvVarPhiPassOptions, VendorCanonicalShapePassOptions {
  readonly writeReports?: boolean;
  readonly now?: string;
}

export interface ResourceNameLintResource {
  readonly resourceType?: string;
  readonly id?: string;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly code?: { readonly text?: string };
  readonly text?: { readonly div?: string };
}

type ForbiddenShape = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly message: string;
  readonly ledgerRow?: number;
  readonly lesson?: string;
};

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const VENDOR_CANONICAL_SHAPES: readonly ForbiddenShape[] = [
  {
    id: "provenance-activity-correct",
    pattern: new RegExp(
      ["Provenance", "\\.activity", "[^\\n]*(?:=|:)", "[^\\n]*['\\\"]?", "correct", "['\\\"]?"].join(""),
      "i",
    ),
    message: "Forbidden Provenance.activity correction shape; use the verified v0.5a Provenance.activity value set.",
    ledgerRow: 18,
    lesson: "v0.5a Lesson 1",
  },
  {
    id: "observation-attestation-property",
    pattern: new RegExp(["Observation", "\\.", "attestation"].join(""), "i"),
    message: "Forbidden invented Observation attestation property; v0.5c uses Provenance + signature surfaces.",
    ledgerRow: 36,
    lesson: "v0.5c Lesson 6",
  },
  {
    id: "provenance-agent-policy",
    pattern: new RegExp(["Provenance", "\\.", "agent", "\\.", "policy"].join(""), "i"),
    message: "Forbidden nested Provenance agent policy path; Provenance.policy is top-level.",
    ledgerRow: 38,
    lesson: "v0.5c Lesson 6",
  },
  {
    id: "observation-partof-observation",
    pattern: new RegExp(["Observation", "\\.", "partOf", "[^\\n]*", "Observation", "/"].join(""), "i"),
    message: "Forbidden Observation-to-Observation partOf succession; use Observation.derivedFrom traversal.",
    ledgerRow: 39,
    lesson: "v0.5c Lesson 7",
  },
  {
    id: "auth-register-endpoint",
    pattern: new RegExp(["/", "auth", "/", "register"].join(""), "i"),
    message: "Forbidden registration endpoint; Medplum first-run provisioning uses auth/newuser and auth/newproject.",
    ledgerRow: 22,
    lesson: "v0.5b Lesson 3",
  },
  {
    id: "shell-into-medplum-server",
    pattern: new RegExp(["compose", "\\s+exec", "\\s+medplum-server"].join(""), "i"),
    message: "Forbidden shell-assumption shape; Medplum server images are shell-less.",
    ledgerRow: 25,
    lesson: "v0.5b Lesson 4",
  },
  {
    id: "binary-fhir-search",
    pattern: new RegExp(["GET", "\\s+/", "fhir", "/", "R4", "/", "Binary", "\\?"].join(""), "i"),
    message: "Forbidden Binary FHIR search shape; use direct Postgres/volume checks for Binary integrity.",
    ledgerRow: 27,
    lesson: "v0.5b Lesson 5",
  },
  {
    id: "cloud-render-domain",
    pattern: new RegExp(["render", "\\.", "com"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "cloud-fly-domain",
    pattern: new RegExp(["fly", "\\.", "io"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "cloud-railway-domain",
    pattern: new RegExp(["railway", "\\.", "app"].join(""), "i"),
    message: "Local-only scope boundary: vendor deploy domains are not v0.5d artifacts.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "signed-baa-copy",
    pattern: new RegExp(["signed ", "BAA"].join(""), "i"),
    message: "Local-only scope boundary: vendor legal approval copy is not a v0.5d artifact.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
  {
    id: "hosted-compliance-tier-copy",
    pattern: new RegExp(["HIPAA", "-tier"].join(""), "i"),
    message: "Local-only scope boundary: hosted compliance-tier copy is not a v0.5d artifact.",
    ledgerRow: 8,
    lesson: "Mandate 15 cloud-retraction calibration",
  },
];

export const PREFLIGHT_ALLOWED_NETWORK_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/localhost(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/\[::1\](?::\d+)?(?:\/|$)/i,
  /^https?:\/\/[a-z0-9_-]+(?::\d+)?(?:\/|$)/i,
];

export function runLogScrubPass(options: LogScrubPassOptions = {}): PreflightPassReport {
  const source = options.source ?? "docker compose logs --tail 500";
  const logText = options.logText ?? readRecentStackLogs();
  const findings = findingsFromPhiText({
    pass: "logs",
    severity: "warning",
    source,
    text: logText,
    messagePrefix: "PHI-shaped value found in recent local stack logs",
  });
  return passReport("logs", findings);
}

export function runResourceNamePass(options: ResourceNamePassOptions = {}): PreflightPassReport {
  const resources = options.resources ?? readResourceNameInventory();
  const findings: PreflightFinding[] = [];

  for (const resource of resources) {
    const resourceType = resource.resourceType ?? "Resource";
    const id = resource.id ?? "unknown";
    const source = `${resourceType}/${id}`;
    for (const [field, value] of lintableResourceFields(resource)) {
      const text = stringifyField(value);
      for (const match of findPhiPatternMatches(text)) {
        findings.push({
          pass: "resource-names",
          severity: "warning",
          code: match.patternId,
          message: `PHI-shaped value found in opaque ${resourceType}.${field}`,
          source,
          line: match.line,
          column: match.column,
        });
      }
    }
  }

  return passReport("resource-names", findings);
}

export function runEnvVarPhiPass(options: EnvVarPhiPassOptions = {}): PreflightPassReport & {
  readonly auditRows: readonly OsodAuditEventRecord[];
} {
  const env = options.env ?? readComposeEnvironment();
  const findings: PreflightFinding[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }
    for (const match of findPhiPatternMatches(value)) {
      findings.push({
        pass: "env-vars",
        severity: "hard-block",
        code: match.patternId,
        message: `PHI-shaped value found in environment variable ${key}`,
        source: key,
        line: match.line,
        column: match.column,
      });
    }
  }

  const auditRows = findings.length
    ? [
        buildOsodAuditEventRow({
          eventType: "preflight-block",
          actorId: "preflight-linter",
          actorRole: "system",
          resourceType: "Environment",
          actionOutcome: "denied",
          actionReason: "v0.5d preflight linter env-var PHI hard-block",
        }),
      ]
    : [];
  return { ...passReport("env-vars", findings), auditRows };
}

export function runVendorCanonicalShapePass(
  options: VendorCanonicalShapePassOptions = {},
): PreflightPassReport {
  const files = options.files ?? readSourceFiles(options.roots ?? defaultSourceRoots());
  const findings: PreflightFinding[] = [];

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const shape of VENDOR_CANONICAL_SHAPES) {
        shape.pattern.lastIndex = 0;
        if (!shape.pattern.test(line)) {
          continue;
        }
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: "hard-block",
          code: shape.id,
          message: shape.message,
          source: displayPath(file.path),
          line: index + 1,
          ledgerRow: shape.ledgerRow,
          lesson: shape.lesson,
        });
      }
      for (const match of line.matchAll(/(["'`])((?:patient|user|system)\/[^"'`\s]+)\1/g)) {
        const scope = match[2]!;
        const verdict = smartScopeLintVerdict(scope);
        if (verdict === "valid-v2" || verdict === "not-smart-resource") {
          continue;
        }
        findings.push({
          pass: "vendor-canonical-shapes",
          severity: verdict === "legacy-warning" ? "warning" : "hard-block",
          code: verdict === "legacy-warning" ? "smart-scope-v1-legacy" : "smart-scope-invalid",
          message:
            verdict === "legacy-warning"
              ? "SMART v1 scope string is backward-compatible only; v2 granular permissions are preferred."
              : "Malformed SMART scope string; expected ledger row 11 grammar.",
          source: displayPath(file.path),
          line: index + 1,
          column: match.index === undefined ? undefined : match.index + 1,
          ledgerRow: 11,
          lesson: "v0.55a SMART scope-string Pass 4 lint",
        });
      }
    }
  }

  return passReport("vendor-canonical-shapes", findings);
}

export function runPreflightLint(options: RunPreflightOptions = {}): PreflightReport {
  const logPass = runLogScrubPass(options);
  const resourcePass = runResourceNamePass(options);
  const envPass = runEnvVarPhiPass(options);
  const shapePass = runVendorCanonicalShapePass(options);
  const passes = [logPass, resourcePass, envPass, shapePass];
  const findings = passes.flatMap((pass) => [...pass.findings]);
  const report: PreflightReport = {
    generatedAt: options.now ?? new Date().toISOString(),
    summary: {
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      hardBlocks: findings.filter((finding) => finding.severity === "hard-block").length,
    },
    passes,
    auditRows: envPass.auditRows,
  };

  if (options.writeReports ?? true) {
    writeReports(report);
  }
  return report;
}

export function assertPreflightNetworkSurface(urls: readonly string[]): void {
  for (const value of urls) {
    const normalized = value.trim();
    if (/[/?#](?:login|password|account[-_]?recovery|recover|reset)/i.test(normalized)) {
      throw new Error("Mandate 8 boundary: preflight linter must not touch login, recovery, or password-change endpoints.");
    }
    if (!PREFLIGHT_ALLOWED_NETWORK_PATTERNS.some((pattern) => pattern.test(normalized))) {
      throw new Error(`Mandate 8 boundary: preflight linter network surface is not local-only: ${normalized}`);
    }
  }
}

function findingsFromPhiText(input: {
  pass: PreflightFinding["pass"];
  severity: PreflightSeverity;
  source: string;
  text: string;
  messagePrefix: string;
}): PreflightFinding[] {
  return findPhiPatternMatches(input.text).map((match: PreflightPhiMatch) => ({
    pass: input.pass,
    severity: input.severity,
    code: match.patternId,
    message: `${input.messagePrefix}: ${match.description}`,
    source: input.source,
    line: match.line,
    column: match.column,
  }));
}

function passReport(id: PreflightPassReport["id"], findings: readonly PreflightFinding[]): PreflightPassReport {
  const status = findings.some((finding) => finding.severity === "hard-block")
    ? "hard-block"
    : findings.length
      ? "warning"
      : "pass";
  return { id, status, findings };
}

function lintableResourceFields(resource: ResourceNameLintResource): [string, unknown][] {
  const resourceType = resource.resourceType ?? "Resource";
  if (resourceType === "Binary") {
    return [["title", resource.title]];
  }
  if (resourceType === "DocumentReference") {
    return [
      ["description", resource.description],
      ["title", resource.title],
    ];
  }
  if (resourceType === "AccessPolicy") {
    return [["name", resource.name]];
  }
  if (resourceType === "Observation") {
    return [
      ["code.text", resource.code?.text],
      ["text.div", resource.text?.div],
    ];
  }
  if (resourceType === "Practitioner") {
    return [["name", resource.name]];
  }
  return [
    ["name", resource.name],
    ["title", resource.title],
    ["description", resource.description],
  ];
}

function stringifyField(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function readRecentStackLogs(): string {
  try {
    const command = composeCommand();
    return execFileSync(command.bin, [...command.args, "logs", "--no-color", "--tail", "500"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function readComposeEnvironment(): Record<string, string> {
  try {
    const command = composeCommand();
    const output = execFileSync(command.bin, [...command.args, "config", "--environment"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseEnvLines(output);
  } catch {
    return Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
}

function readResourceNameInventory(): ResourceNameLintResource[] {
  const postgresUrl = process.env.OSOD_POSTGRES_URL ?? "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
  const resourceTypes = [
    "Patient",
    "Practitioner",
    "Observation",
    "DocumentReference",
    "Binary",
    "AccessPolicy",
  ];
  return resourceTypes.flatMap((resourceType) => readResourceTable(postgresUrl, resourceType));
}

function readResourceTable(postgresUrl: string, resourceType: string): ResourceNameLintResource[] {
  const sql = `
    SELECT COALESCE(json_agg(content::json), '[]'::json)::text
    FROM (
      SELECT content
      FROM "${resourceType}"
      WHERE deleted = false
      LIMIT 200
    ) resource_sample;
  `;
  try {
    const output = execFileSync("psql", [postgresUrl, "-Atc", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return JSON.parse(output || "[]") as ResourceNameLintResource[];
  } catch {
    return [];
  }
}

function parseEnvLines(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      env[match[1]!] = match[2]!;
    }
  }
  return env;
}

function composeCommand(): { bin: string; args: string[] } {
  if (hasCommand("docker")) {
    return { bin: "docker", args: ["compose"] };
  }
  return { bin: "docker-compose", args: [] };
}

function hasCommand(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultSourceRoots(): string[] {
  return ["mcp/src", "ui/src", "policy", "data", "scripts", "tests"].map((path) => resolve(REPO_ROOT, path));
}

function readSourceFiles(roots: readonly string[]): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const root of roots) {
    walk(resolve(root), files);
  }
  return files;
}

function walk(path: string, files: { path: string; text: string }[]): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (![".git", ".osod", "dist", "node_modules"].includes(entry.name)) {
        walk(child, files);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) {
      continue;
    }
    files.push({ path: child, text: readFileSync(child, "utf8") });
  }
}

function displayPath(path: string): string {
  return relative(REPO_ROOT, path) || path;
}

function writeReports(report: PreflightReport): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "preflight-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(REPORT_DIR, "preflight-report.md"), renderMarkdownReport(report));
}

function renderMarkdownReport(report: PreflightReport): string {
  const lines = [
    "# OSOD Preflight Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Warnings: ${report.summary.warnings}`,
    `Hard blocks: ${report.summary.hardBlocks}`,
    "",
  ];
  for (const pass of report.passes) {
    lines.push(`## ${pass.id}: ${pass.status}`, "");
    if (!pass.findings.length) {
      lines.push("No findings.", "");
      continue;
    }
    for (const finding of pass.findings) {
      const location = finding.source
        ? ` (${finding.source}${finding.line ? `:${finding.line}` : ""})`
        : "";
      const citation = finding.ledgerRow ? ` Ledger row ${finding.ledgerRow}; ${finding.lesson ?? "lesson recorded"}.` : "";
      lines.push(`- ${finding.severity}: ${finding.code}${location} - ${finding.message}.${citation}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runPreflightLint();
  const message = `OSOD preflight complete: ${report.summary.warnings} warning(s), ${report.summary.hardBlocks} hard block(s). Reports: .osod/preflight-report.json and .osod/preflight-report.md`;
  console.log(message);
  if (report.summary.hardBlocks > 0) {
    process.exitCode = 1;
  }
}
