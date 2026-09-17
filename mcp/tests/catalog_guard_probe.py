"""Reproduce each O1 guard against the CI Postgres variable, restoring source bytes."""
from pathlib import Path
import json
import os
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
reader = root / "mcp/src/comms/visionforge-education-catalog.ts"
comms = root / "mcp/src/comms/comms-api.ts"
seed = root / "mcp/src/comms/education-catalog.ts"
generator = root / "mcp/src/clinical-graph/plan-sets/generator.ts"
reader_test_file = root / "mcp/tests/visionforgeEducationCatalog.test.ts"
store_test_file = root / "mcp/tests/educationCatalogSnapshotStore.test.ts"
census = root / "scripts/fhir-read-grant-check.ts"
output_dir = Path("/tmp/odos-o1b-guards")
output_dir.mkdir(exist_ok=True)
if not os.environ.get("ODOS_POSTGRES_URL"):
    raise SystemExit("Set ODOS_POSTGRES_URL to a disposable local Postgres URL (CI uses this variable).")
if os.environ.get("ODOS_CATALOG_TEST_POSTGRES_URL"):
    raise SystemExit("Unset ODOS_CATALOG_TEST_POSTGRES_URL; this probe must run in CI-shaped mode.")
env = dict(os.environ)
reader_test = "tests/visionforgeEducationCatalog.test.ts"
comms_test = "tests/educationEnrollmentApi.test.ts"


def replace(old, new):
    def edit(source):
        count = source.count(old)
        if count != 1:
            raise RuntimeError(f"Expected one occurrence, found {count}: {old[:80]!r}")
        return source.replace(old, new, 1)
    return edit


def bypass_refresh_auth(source):
    start = source.index('  app.post("/communications/education/catalog/refresh", catalogRefreshLimit')
    end = source.index('  app.get("/communications/education/:educationId"', start)
    return source[:start] + (
        '  app.post("/communications/education/catalog/refresh", catalogRefreshLimit, '
        'async (_req, res) => { res.status(200).json(catalogStatus()); });\n\n'
    ) + source[end:]


def move_seed_pin(source):
    lines = source.splitlines(keepends=True)
    lines.insert(5, "\n")
    return "".join(lines)


def switch_plan_set_default(source):
    source = replace(
        "catalog: EducationCatalogReader = loadDefaultEducationCatalogReader()",
        'catalog: EducationCatalogReader = createEducationCatalogFromEnv({ VISIONFORGE_BASE_URL: "https://vf.example.test", VISIONFORGE_PRACTICE_ID: "o1-practice-a", VISIONFORGE_SEAM_TOKEN: "synthetic" })',
    )(source)
    return 'import { createEducationCatalogFromEnv } from "../../comms/visionforge-education-catalog.js";\n' + source


def restore_catalog_skip(sources):
    reader_source, store_source = sources
    return (
        replace(
            "const catalogTest = test;",
            "const catalogTest = (name: string, run: (t: TestContext) => Promise<void>) => test(name, { skip: !process.env.ODOS_CATALOG_TEST_POSTGRES_URL }, run);",
        )(reader_source),
        replace(
            "test('snapshot persistence keeps accepted evidence and local copy unchanged on refusal and 304', async () => {",
            "test('snapshot persistence keeps accepted evidence and local copy unchanged on refusal and 304', { skip: !process.env.ODOS_CATALOG_TEST_POSTGRES_URL }, async () => {",
        )(store_source),
    )


cases = [
    ("G1", reader, replace("if (value.practiceId !== config.practiceId)", "if (false && value.practiceId !== config.practiceId)"), reader_test, "refusal practice-mismatch preserves"),
    ("G2", reader, replace("if (!seen.has(id)) localCopy.push", "if (false && !seen.has(id)) localCopy.push"), reader_test, "G2 G20 C0 absence"),
    ("G2b", reader, replace("if (envelope.entries.length === 0 && previous.size > 0)", "if (false && envelope.entries.length === 0 && previous.size > 0)"), reader_test, "refusal catalog-emptied preserves"),
    ("G3", reader, replace("prior.manifestSha256 !== entry.manifestSha256", "false"), reader_test, "refusal meaning-changed preserves"),
    ("G4", reader, replace("if (!(from === to ||", "if (false && !(from === to ||"), reader_test, "refusal lifecycle-regressed preserves"),
    ("G5", reader, replace("    const validated = validate(input);", "    if (snapshot) await store.accept({ ...snapshot, envelope: input });\n    const validated = validate(input);"), reader_test, "refusal entry-invalid preserves"),
    ("G6", reader, replace("if (entry.item.dxCodes.some(code => !verifiedCodes.has(code)))", "if (false && entry.item.dxCodes.some(code => !verifiedCodes.has(code)))"), reader_test, "refusal dx-code-unverified preserves"),
    ("G7", reader, replace("if (Object.values(entry.item.urls).some(url => url &&", "if (false && Object.values(entry.item.urls).some(url => url &&"), reader_test, "refusal url-origin-mismatch preserves"),
    ("G8", reader, replace('entry.item.version === version && effectiveLifecycle(entry) !== "withdrawn"', "entry.item.version === version"), comms_test, "O1 scheduled preparation accepts retained"),
    ("G9", comms, replace("deps.educationCatalog.getForNewWork(send.educationId, send.version)", "deps.educationCatalog.get(send.educationId, send.version)"), comms_test, "O1 refuses new immediate enrollment for history@1"),
    ("G10", comms, replace('body.initialStage.sequence, "new-enrollment"', 'body.initialStage.sequence, "existing-enrollment"'), comms_test, "O1 refuses new sequence enrollment for history@1"),
    ("G11", comms, replace('dispatchEducation(deps, staff, patient, body, "new-enrollment")', 'dispatchEducation(deps, staff, patient, body, "existing-enrollment")'), comms_test, "O1 refuses one-off dispatch for history@1"),
    ("G11b", comms, replace('}, "existing-enrollment", { reconcileOnly, senderReference: current.enrolledBy });', '}, "new-enrollment", { reconcileOnly, senderReference: current.enrolledBy });'), comms_test, "O1 claimed transition delivery accepts content retired after claim"),
    ("G12", reader, replace("const row = await store.load(config.practiceId);", "const row = undefined;"), reader_test, "G12 restart with upstream unreachable"),
    ("G13", reader, replace('return recordAttempt("not-modified", null, at);', 'return recordAttempt("refused", "http-304", at);'), reader_test, "G13 captured 304 preserves"),
    ("G14", reader, replace("if (names.every(name => env[name] === undefined))", "if (names.some(name => env[name] === undefined))"), reader_test, "G14 seed only for entirely unset"),
    ("G15", reader, replace("practiceId: config.practiceId, asOf: snapshot?.asOf", "practiceId: config.practiceId, token: config.token, asOf: snapshot?.asOf"), reader_test, "G15 configured status contains neither"),
    ("G16", comms, bypass_refresh_auth, comms_test, "O1 seed catalog staff status and refresh"),
    ("G17", reader, replace("refresh: () => inFlight ??= refreshOnce().finally(() => { inFlight = undefined; }),", "refresh: () => refreshOnce(),"), reader_test, "G17 concurrent refreshes coalesce"),
    ("G18", seed, move_seed_pin, reader_test, "G18 pinned ODOS schema bytes"),
    ("G19", generator, switch_plan_set_default, reader_test, "G19 plan-set and protocol defaults"),
    ("G20", reader, replace("snapshot = structuredClone(row);", 'snapshot = { ...structuredClone(row), localCopy: (row.envelope as any).entries.map((entry: any) => ({ ...entry, absentUpstream: false, asOf: row.asOf })) };'), reader_test, "G2 G20 C0 absence"),
    ("G21", census, replace('line: 7898, callee: "fhir.patch"', 'line: 7895, callee: "fhir.patch"'), None, None),
    ("G22", reader, replace('const loopbackHttp = base.protocol === "http:" && (base.hostname === "127.0.0.1" || base.hostname === "[::1]");', 'const loopbackHttp = base.protocol === "http:";'), reader_test, "G22 HTTPS is required"),
    ("G23", reader, replace('signal, redirect: "error",', 'signal, redirect: "follow",'), reader_test, "G23 redirected seam"),
    ("G24", reader, replace('if (baseline === "failed" || baseline === "unloaded") {', 'if (false && (baseline === "failed" || baseline === "unloaded")) {'), reader_test, "G24 failed boot"),
    ("G25", (reader_test_file, store_test_file), restore_catalog_skip, "tests/educationCatalogCiPresence.test.ts", "G25 catalog persistence tests execute"),
    ("G26", reader, replace('version === undefined ? effectiveLifecycle(entry) !== "withdrawn"', 'version === undefined ? effectiveLifecycle(entry) === "active"'), comms_test, "G26 staff read resolves"),
]


def command(test_file, pattern):
    if test_file is None:
        return ["node", "--import", "tsx", "scripts/fhir-read-grant-check.ts"], root
    return ["node", "--import", "tsx", "--test", "--test-concurrency=1", "--test-name-pattern", pattern, test_file], root / "mcp"


def run(name, phase, test_file, pattern):
    cmd, cwd = command(test_file, pattern)
    result = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    output = result.stdout + result.stderr
    (output_dir / f"{name}-{phase}.tap").write_text(output)
    def count(label):
        match = re.search(r"^# " + label + r" (\d+)$", output, re.M)
        return int(match.group(1)) if match else None
    return {"exit": result.returncode, "pass": count("pass"), "fail": count("fail"), "skip": count("skipped"),
            "command": " ".join(cmd), "cwd": str(cwd)}


def probe(name, paths, edit, test_file, pattern):
    paths = paths if isinstance(paths, tuple) else (paths,)
    originals = tuple(path.read_bytes() for path in paths)
    try:
        mutated = edit(tuple(source.decode() for source in originals) if len(paths) > 1 else originals[0].decode())
        mutated = mutated if isinstance(mutated, tuple) else (mutated,)
        for path, original, changed in zip(paths, originals, mutated):
            if changed.encode() == original:
                raise RuntimeError(f"{name}: mutation left {path} unchanged")
            path.write_text(changed)
        red = run(name, "red", test_file, pattern)
    finally:
        for path, original in zip(paths, originals):
            path.write_bytes(original)
            if path.read_bytes() != original:
                raise RuntimeError(f"{name}: restoration failed for {path}")
    green = run(name, "green", test_file, pattern)
    result = {"guard": name, "red": red, "green": green}
    (output_dir / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"{name}: red={red['exit']}/{red['pass']}/{red['fail']}/{red['skip']}; "
          f"green={green['exit']}/{green['pass']}/{green['fail']}/{green['skip']}", flush=True)
    if name == "G21":
        assert red["exit"] != 0 and green["exit"] == 0
    else:
        assert red["exit"] != 0 and red["fail"] and green["exit"] == 0 and green["pass"] and green["fail"] == 0


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    if not wanted:
        raise SystemExit("Pass one or more guard IDs, e.g. G1 G24; mutations run sequentially.")
    known = {case[0] for case in cases}
    if wanted - known:
        raise SystemExit(f"Unknown guards: {sorted(wanted - known)}")
    for case in cases:
        if case[0] in wanted:
            probe(*case)
