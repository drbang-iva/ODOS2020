#!/usr/bin/env python3
"""Demonstrate B1-B6 against the route tests, restoring each mutation even on failure."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
gate = root / "mcp/src/comms/suppression-gate.ts"
api = root / "mcp/src/comms/comms-api.ts"
roles = root / "mcp/src/authz/roles.ts"


def replace_once(text, old, new):
    assert old in text, old
    return text.replace(old, new, 1)


def mutate(tag, text):
    if tag == "B1":
        text = replace_once(text, 'const reason = requiredText(body.reason, "reason", 2_000);', 'const reason = String(body.reason ?? "");')
        return replace_once(text, 'typeof body.identityVerification !== "string"\n    || !SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.includes(', 'false && (typeof body.identityVerification !== "string"\n    || !SMS_OPT_OUT_IDENTITY_VERIFICATION_METHODS.includes(').replace('body.identityVerification as SmsOptOutIdentityVerification,\n    )\n  )', 'body.identityVerification as SmsOptOutIdentityVerification,\n    ))\n  )', 1)
    if tag == "B2":
        return replace_once(text, '{ url: "channel", valueCode: "sms" }', '{ url: "channel", valueCode: "sms-staff" }')
    if tag == "B3":
        return replace_once(text, 'duplicate ? existing : [...existing, {', 'duplicate ? existing : [{')
    if tag == "B4":
        return replace_once(text, 'const duplicate = existing.some((extension) => isOwnedSmsOptOut(extension) && smsOptOutNumber(extension) === number);', 'const duplicate = false;')
    if tag == "B5":
        start = text.index('  staff: {')
        return text[:start] + replace_once(text[start:], '      "communications.optout.manage",', '      // B5 mutation: staff opt-out action removed')
    if tag == "B6":
        return replace_once(text, 'scope === "per-number" ? { number: requiredE164(body.number, "number") }', 'scope === "per-number" ? { number: body.number as string }')
    raise AssertionError(tag)


for tag, path, pattern in [
    ("B1", api, 'const reason = String'),
    ("B2", gate, 'sms-staff'),
    ("B3", gate, 'duplicate ? existing : [{'),
    ("B4", gate, 'const duplicate = false'),
    ("B5", roles, 'B5 mutation: staff opt-out action removed'),
    ("B6", api, 'number: body.number as string'),
]:
    original = path.read_text()
    command = ['node', '--import', './mcp/node_modules/tsx/dist/loader.mjs', '--test', f'--test-name-pattern={tag} ', 'mcp/tests/commsApi.test.ts']
    try:
        path.write_text(mutate(tag, original))
        with open(f'/tmp/consent-{tag}-red.log', 'w') as log:
            log.write(f'Mutation {tag}: {path.relative_to(root)}\n'); log.flush()
            confirmed = subprocess.run(['rg', '-n', '-F', pattern, str(path)], cwd=root, stdout=log, stderr=log)
            assert confirmed.returncode == 0
            result = subprocess.run(command, cwd=root, stdout=log, stderr=log)
        assert result.returncode != 0, f'{tag} mutation survived'
    finally:
        path.write_text(original)
    with open(f'/tmp/consent-{tag}-green.log', 'w') as log:
        result = subprocess.run(command, cwd=root, stdout=log, stderr=log)
    assert result.returncode == 0, f'{tag} restoration failed'
    print(f'{tag}: confirmed mutation RED; restored GREEN', flush=True)
