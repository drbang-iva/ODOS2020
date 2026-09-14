import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
engine = root / "mcp/src/clinic/guarantor-link-operation.ts"
screen = root / "ui/src/components/patient/GuarantorLinkScreens.tsx"

step_zero = '''    if (this.plan.kind === "correct" && !this.ownershipLanded()) {
      const original = await this.operation.read<Task>("Task", this.plan.originalTaskId!);
      if (!this.operation.trusted(original)) return this.pause("interfered", reference(original));
      if (original.status !== "completed" && original.status !== "in-progress") {
        await this.checkpointTask("cancelled", "superseded");
        await this.audit("pending", "superseded", reference(original));
        return true;
      }
    }
'''
owners_check = 'if (owners.length > 1 || owners.some(p => ![this.plan.sourcePersonId, this.plan.destinationPersonId].includes(p.id!)) || (original.status === "completed" && !equalIds(owners.map(p => p.id!), [this.plan.sourcePersonId]))) return this.fail("correction-conflict", reference(child));'
owners_mutant = 'if (owners.length > 1 || owners.some(p => ![this.plan.sourcePersonId, this.plan.destinationPersonId].includes(p.id!))) return this.fail("correction-conflict", reference(child));'
complete_visibility = 'op.kind==="correct"&&op.task.status==="in-progress"&&<button'

cases = [
    ("R7", engine, step_zero, "", "mcp", "tests/guarantorRecoveryFixback.test.ts", "^R7:"),
    ("R8", engine, owners_check, owners_mutant, "mcp", "tests/guarantorRecoveryFixback.test.ts", "^R8:"),
    ("R9", screen, complete_visibility, 'false&&<button', "ui", "tests/guarantorRecoveryFixback.test.tsx", "^R9"),
]
records = []


def run_case(label, state, package, test_file, pattern):
    command = ["node", "--import", "tsx", "--test", "--test-name-pattern=" + pattern, test_file]
    result = subprocess.run(command, cwd=root / package, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout.replace("file://" + str(root) + "/", "").replace(str(root) + "/", "")
    (evidence / f"{label}-fixback-{state}.tap").write_text(output)
    return {
        "command": command,
        "cwd": package,
        "exitCode": result.returncode,
        "counts": dict(re.findall(r"^# (tests|pass|fail|skipped) (\d+)$", output, re.M)),
        "failingTests": re.findall(r"^not ok \d+ - (.*)$", output, re.M),
        "diagnostics": re.findall(r"^# ({.*})$", output, re.M),
    }


for label, path, before, after, package, test_file, pattern in cases:
    original = path.read_text()
    assert original.count(before) == 1, f"{label}: mutation anchor must match exactly once"
    green = run_case(label, "green", package, test_file, pattern)
    assert green["exitCode"] == 0, (label, green)
    mutant = original.replace(before, after)
    record = {
        "guard": label,
        "file": str(path.relative_to(root)),
        "before": before,
        "after": after,
        "sourceSha256": hashlib.sha256(original.encode()).hexdigest(),
        "green": green,
    }
    try:
        path.write_text(mutant)
        assert path.read_text() == mutant and mutant != original
        record["mutantSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        record["red"] = run_case(label, "red", package, test_file, pattern)
    finally:
        path.write_text(original)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == record["sourceSha256"]
    record["restored"] = run_case(label, "restored", package, test_file, pattern)
    records.append(record)
    (evidence / "fixback-mutations.json").write_text(json.dumps(records, indent=2) + "\n")
    print(json.dumps({
        "guard": label,
        "green": green["counts"],
        "red": record["red"]["counts"],
        "failingTests": record["red"]["failingTests"],
        "redDiagnostics": record["red"]["diagnostics"],
        "restored": record["restored"]["counts"],
    }), flush=True)
    assert record["red"]["exitCode"] != 0 and record["red"]["failingTests"], (label, "mutation survived")
    assert record["restored"]["exitCode"] == 0, (label, "restored run failed")
