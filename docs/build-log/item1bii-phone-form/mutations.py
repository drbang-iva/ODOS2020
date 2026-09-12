"""Run from the repository root; each mutation is restored before the next guard."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path.cwd()
OUT = Path(os.environ.get("PHONE_EVIDENCE_DIR", "/tmp/odos-phone-textable-evidence")) / "mutations"
OUT.mkdir(parents=True, exist_ok=True)
UI = "ui/src/lib/patient-registration.ts"
FORM = "ui/src/components/patient/PatientDemographicsEditor.tsx"
SHARED = "mcp/src/clinic/patient-telecom.ts"
SERVER = "mcp/src/clinic/patient-registration-endpoint.ts"
cases = [
    ("K1", UI, '.sort((a, b) => priority(a.point) - priority(b.point) || a.sourceIndex - b.sourceIndex)', '.sort((a, b) => a.sourceIndex - b.sourceIndex)', "Order slots by array position"),
    ("K2", UI, 'const changed = slot.value !== original.value || useChanged;', 'const changed = true;', "Trim untouched slot values"),
    ("K2-absence", UI, '...(point.value === undefined ? {} : { value: point.value }),', 'value: point.value ?? "",', "Substitute an empty string for an absent snapshot value"),
    ("K3", UI, 'if (!slot.value.trim()) return [];', 'if (!slot.value.trim()) return [{ ...point, value: "" }];', "Serialize a cleared slot with an empty value"),
    ("K4", SHARED, 'const errors: Record<string, string> = {};', 'const errors: Record<string, string> = {}; if (phones.every(p => !p.value.trim())) errors.phone = "Phone number is required.";', "Restore required-phone validation"),
    ("K5", SHARED, 'return value ? { system: "phone", use: slot.use, value } : undefined;', 'return { system: "phone", use: slot.use, value };', "Create a phone even when its value is blank"),
    ("K6", SHARED, 'if (extensions?.length === point.extension?.length) return point;', 'if (point !== answer) return point;', "Set the selected marker without clearing others"),
    ("K7", SHARED, 'return { ...patient, extension: [...(otherExtensions ?? []),', 'return { ...patient, telecom: patient.telecom?.map(point => ({ ...point, extension: point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL) })), extension: [...(otherExtensions ?? []),', "Clear ContactPoint markers when choosing Neither"),
    ("K8", SHARED, 'const otherExtensions = patient.extension?.filter(e => e.url !== ODOS_NO_TEXTABLE_NUMBER_EXTENSION_URL);', 'const otherExtensions = patient.extension;', "Leave the Patient refusal when choosing a phone"),
    ("K9", UI, '  return patient;\n}', '  if (draft.textable === "") patient.telecom = patient.telecom?.map(point => ({ ...point, extension: point.extension?.filter(e => e.url !== ODOS_TEXTABLE_NUMBER_EXTENSION_URL) }));\n  return patient;\n}', "Treat an unanswered question as clear-all"),
    ("K10", SHARED, 'return value ? { system: "phone", use: slot.use, value } : undefined;', 'return value ? { system: "phone", use: "home", value } : undefined;', "Hardcode new phones to home"),
    ("K11", UI, 'const useChanged = slot.use !== "other" && slot.use !== original.use;', 'const useChanged = false;', "Ignore the dropdown edit"),
    ("K12", SHARED, 'const errors: Record<string, string> = {};', 'const errors: Record<string, string> = {}; if (phones.every(p => !p.value.trim())) errors.phone = "Phone number is required.";', "Restore required-phone validation for H14"),
    ("K13", FORM, 'textable: index === 0 ? "phone1" : "phone2"', 'textable: "phone1"', "Wire the Phone 2 control to Phone 1"),
    ("K14", UI, '    ...(existing ?? {}),', '    ...(existing ?? {}), extension: undefined,', "Drop unrelated Patient extensions on save"),
    ("K15", FORM, '      setHeldPatient(fresh);', '      setHeldPatient(fresh);\n      setEdit(edit => ({ ...edit, snapshot: patientTelecomSnapshot(fresh, edit.snapshot.now) }));', "Retake the snapshot during preference refresh"),
    ("K16", SERVER, '  if (input.demographics.textable) {', '  if (false) {', "Omit server marker and refusal application"),
    ("R2", SHARED, 'if (textable === `phone${index + 1}` && (!slot.value.trim() || !valid))', 'if (false)', "Allow an empty selected texting slot"),
]

def run(label, phase, command, cwd):
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout.replace(str(ROOT), "<worktree>")
    (OUT / f"{label}-{phase}.log").write_text(output)
    counts = {key: int(value) for key, value in re.findall(r"^# (tests|pass|fail|skipped|cancelled) (\d+)$", output, re.M)}
    return {"exit": result.returncode, **counts}, output

results = []
for label, filename, original, replacement, fault in cases:
    path = ROOT / filename
    source = path.read_text()
    assert source.count(original) == 1, (label, "mutation anchor must be unique")
    guard = label.split("-")[0]
    package = "mcp" if guard in ["K5", "K16"] else "ui"
    tests = ["tests/patientRegistrationAuthz.test.ts"] if package == "mcp" else ["tests/patientPhoneForm.test.tsx"]
    pattern = f"^{guard}:"
    if guard == "K12":
        tests.append("tests/patientRegistration.test.tsx")
        pattern += "|^H14:"
    command = ["node", "--import", "tsx", "--test", f"--test-name-pattern={pattern}", *tests]
    green, _ = run(label, "green", command, ROOT / package)
    assert green["exit"] == 0 and green.get("fail") == 0 and green.get("tests", 0) > 0, (label, green)
    mutated = source.replace(original, replacement)
    try:
        path.write_text(mutated)
        assert path.read_text() == mutated and mutated != source
        red, output = run(label, "red", command, ROOT / package)
        expected_failure = "ERR_ASSERTION" in output or (guard in ["K4", "K12"] and "Phone number is required." in output)
        assert red["exit"] != 0 and red.get("fail", 0) > 0 and expected_failure, (label, red, output[-2000:])
        assert not any(error in output for error in ["SyntaxError", "TransformError", "ERR_MODULE_NOT_FOUND"]), label
    finally:
        path.write_text(source)
        assert path.read_text() == source
    restored, _ = run(label, "restored", command, ROOT / package)
    assert restored["exit"] == 0 and restored.get("fail") == 0, (label, restored)
    results.append({"guard": label, "fault": fault, "file": filename, "original": original, "replacement": replacement,
                    "sourceSha256": hashlib.sha256(source.encode()).hexdigest(), "mutantSha256": hashlib.sha256(mutated.encode()).hexdigest(),
                    "cwd": package, "command": command, "green": green, "red": red, "restored": restored})
    (OUT / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"{label}: green {green['pass']} / red {red['fail']} / restored {restored['pass']}", flush=True)
