"""Run from the task worktree root. Mutates one guard at a time and restores exact bytes."""
from pathlib import Path
import re
import subprocess

PREFIX = ["npm", "--prefix", "mcp", "test", "--"]
WORKER_TESTS = ["tests/educationSequenceWorker.test.ts", "tests/educationSequenceWorkerStore.test.ts"]
WORKER = "mcp/src/comms/education-sequence-worker.ts"
STORE = "mcp/src/comms/education-sequence-store.ts"
ENROLLMENT = "mcp/src/comms/education-enrollment.ts"

def once(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new)

def exemption(text):
    text = once(text, '''  if (actor.kind === "system" && "quietHoursExemption" in actor) {
    throw new CommsApiRefusalError("system actor cannot carry a quiet-hours exemption");
  }
''', "")
    return once(text, 'actor.kind === "staff" && item.consentClass === "transactional"', 'item.consentClass === "transactional"')

def successor(text):
    text = once(text, "    const last = row.attempts.at(-1);", "    const last = row.attempts[0];")
    return once(text, "    if (row.attempts.some(a => a.predecessorAttemptKey === last.attemptKey))\n        return snapshot;", "")

GUARDS = [
    (1, "mcp/src/comms/comms-api.ts", exemption, ["tests/educationDispatchActor.test.ts"]),
    (2, WORKER, lambda s: once(s, "        await deps.authenticate();", "        await deps.authenticate();\n        await (deps.store as any).transition();"), WORKER_TESTS),
    (3, ENROLLMENT, lambda s: once(s, 'return await fhir.update<Basic>("Basic", resource.id!, resource, enrollmentVersionHeaders(resource));', 'return await fhir.update<Basic>("Basic", resource.id!, resource, enrollmentVersionHeaders(await fhir.read<Basic>("Basic", resource.id!)));'), WORKER_TESTS),
    (4, "mcp/src/comms/education-sequence.ts", lambda s: once(s, 'if (send.state === "pending" && (enrollment.status', 'if ((send.state === "pending" || send.state === "in-flight") && (enrollment.status'), WORKER_TESTS),
    (5, WORKER, lambda s: once(s, "                    if (handledPatients.has(enrollment.patientReference))\n                        continue;", ""), WORKER_TESTS),
    (6, STORE, successor, WORKER_TESTS),
    (7, WORKER, lambda s: once(s, '''catch {
                await report(deps, { enrollmentId: resource.id ?? "unknown", reason: "malformed-enrollment", at: deps.now?.() ?? new Date().toISOString() });
                continue;
            }''', "catch(error){throw error;}"), WORKER_TESTS),
    (8, ENROLLMENT, lambda s: once(s, "      const updated = await updateEnrollmentResource(fhir, resource);", '      const updated = await fhir.update<Basic>("Basic", resource.id!, resource, enrollmentVersionHeaders(resource));'), ["tests/educationEnrollmentApi.test.ts", "tests/educationSequenceFhir.test.ts"]),
    (9, WORKER, lambda s: once(s, 'if (!["waiting", "scheduled"].includes(row.disposition) || snapshot.enrollment.status !== "active")', 'if (snapshot.enrollment.status !== "active")'), WORKER_TESTS),
]

def run(number, phase, files):
    result = subprocess.run(PREFIX + files, capture_output=True, text=True)
    output = result.stdout + result.stderr
    Path(f"/tmp/odos-seq2-guard{number}-{phase}.log").write_text(output)
    counts = dict(re.findall(r"^# (tests|pass|fail|skipped) (\d+)", output, re.M))
    print(f"GUARD {number} {phase.upper()} exit={result.returncode} {counts}", flush=True)
    assert counts, "No test counts; harness failure is not a guard demonstration"
    return result.returncode, int(counts["fail"])

if __name__ == "__main__":
    for number, filename, mutate, files in GUARDS:
        assert run(number, "baseline", files) == (0, 0)
        path = Path(filename)
        original = path.read_bytes()
        try:
            changed = mutate(original.decode())
            subprocess.run(["git", "diff", "--numstat"], check=True)
            path.write_text(changed)
            assert path.read_bytes() != original
            code, failures = run(number, "red", files)
            assert code != 0 and failures > 0, f"Guard {number} survived"
        finally:
            subprocess.run(["git", "diff", "--numstat"], check=True)
            path.write_bytes(original)
            assert path.read_bytes() == original
        assert run(number, "green", files) == (0, 0)
