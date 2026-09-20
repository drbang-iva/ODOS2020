"""Run one product mutation at a time in a disposable checkout, restoring exact bytes."""
from pathlib import Path
import difflib
import gzip
import hashlib
import json
import os
import subprocess
import sys

checkout = Path(sys.argv[1]).resolve()
evidence = Path(__file__).resolve().parent.parent / 'mutations'
evidence.mkdir(exist_ok=True)
assert checkout != Path(__file__).resolve().parents[4]
api = 'mcp/src/comms/comms-api.ts'
gate = 'mcp/src/comms/suppression-gate.ts'
envelope = 'mcp/src/comms/patient-email-envelope.ts'
schema = 'mcp/src/comms/education-catalog.ts'
cases = [
 ('a-subject', envelope, 'return subject;', 'return "Synthetic condition handout";', 'E1a a', 'tests/commsApi.test.ts'),
 ('a-footer', 'mcp/src/comms/adapters/google-workspace-adapter.ts', '`${request.body}\\n\\n${footer}`', 'request.body', 'E1a a|E1a configured neutral', 'tests/commsApi.test.ts', 'tests/googleWorkspaceAdapter.test.ts'),
 ('a-chart-title', api, 'body, item, recipientValue: recipient.value', 'body, item: { ...item, title: "" }, recipientValue: recipient.value', 'E1a a', 'tests/commsApi.test.ts'),
 ('a-provenance-title', api, 'display: `Education content: ${input.item.id}@${input.item.version}`', 'display: `Education content: ${input.item.id}@${input.item.version} ${input.item.title}`', 'E1a a', 'tests/commsApi.test.ts'),
 ('b-required', envelope, 'if (!text) throw new PatientEmailConfigurationError(`Patient email is missing ${field} in practice settings.`);', 'if (!text) return "";', 'E1a b', 'tests/commsApi.test.ts'),
 ('b-unresolved', envelope, 'if (/[{}]|<[^>]*>/.test(text))', 'if (false)', 'E1a envelope refuses missing or unresolved.*[{}]', 'tests/googleWorkspaceAdapter.test.ts'),
 ('c-cosmetic', api, 'if (item.offerClass === "cosmetic")', 'if (false)', 'E1a c|E1a sequence cosmetic', 'tests/commsApi.test.ts', 'tests/educationDispatchActor.test.ts'),
 ('d-unsubscribe', api, 'item.consentClass === "marketing" && channel === "email" && !deps.emailUnsubscribeEndpoint?.trim()', 'false', 'E1a d|E1a sequence unsubscribe|E1a prepared email', 'tests/commsApi.test.ts', 'tests/educationDispatchActor.test.ts'),
 ('e-consent-api', api, 'body.channel === "sms" && item.consentClass === "marketing" && !hasRecordedMarketingConsent(patient)', 'item.consentClass === "marketing" && !hasRecordedMarketingConsent(patient)', 'E1a e.*allowed=true', 'tests/commsApi.test.ts'),
 ('e-consent-wrapper', gate, 'channel === "sms" && request.suppression.requiresMarketingConsent', 'request.suppression.requiresMarketingConsent', 'E1a email wrapper', 'tests/commsSuppression.test.ts'),
 ('e-explicit-off', gate, 'if (purpose && !effectiveCommsPreferences(patient, deps)[purpose][channel].value', 'if (false && purpose && !effectiveCommsPreferences(patient, deps)[purpose][channel].value', 'E1a e.*allowed=false', 'tests/commsApi.test.ts'),
 ('f-override', api, 'const staffEducationOverride = actor.kind === "staff" && item.consentClass === "transactional";', 'const staffEducationOverride = false;', 'E1a f', 'tests/commsApi.test.ts'),
 ('f-write-on', api, 'if (withheldEducationEmail && actor.kind === "staff")', 'if (false)', 'E1a f', 'tests/commsApi.test.ts'),
 ('sequence-probe', api, 'subject: prepared.subject,', 'subject: prepared.item.title,', 'E1a sequence preflight', 'tests/educationDispatchActor.test.ts'),
 ('sequence-send', api, '      subject,\n      body: url,', '      subject: item.title,\n      body: url,', 'E1a sequence preflight', 'tests/educationDispatchActor.test.ts'),
 ('wrapper-validation', gate, '...(provider.validateEmailConfiguration ? { validateEmailConfiguration: provider.validateEmailConfiguration } : {}),', '', 'E1a b|E1a email wrapper', 'tests/commsApi.test.ts', 'tests/commsSuppression.test.ts'),
 ('scheduled-detail', 'mcp/src/comms/education-sequence-worker.ts', 'prepared.detail ?? prepared.reason', 'prepared.reason', 'E1a scheduled', 'tests/educationSequenceWorker.test.ts'),
 ('catalog-required', schema, 'item.consentClass === "marketing" && item.offerClass === undefined', 'false', 'E1a catalog|G18|E1a published marketing', 'tests/educationCatalog.test.ts', 'tests/visionforgeEducationCatalog.test.ts'),
 ('catalog-default', schema, 'offerClass: item.offerClass ?? "eyecare"', 'offerClass: item.offerClass', 'E1a catalog|G18', 'tests/educationCatalog.test.ts', 'tests/visionforgeEducationCatalog.test.ts'),
 ('catalog-propagation', schema, '.transform(item => ({ ...item, offerClass: item.offerClass ?? "eyecare" }))', '.transform(item => ({ ...item, offerClass: "eyecare" as const }))', 'E1a published cosmetic', 'tests/visionforgeEducationCatalog.test.ts'),
 ('ui-disclosure', 'ui/src/components/comms/EngageSheet.tsx', '{pending.educationEmailWithheld && <p className="text-sm text-[color:var(--odos-amber)]">Education email is off for this patient. Sending will turn it back on.</p>}', '', 'E1a education email disclosure', 'tests/engageCommunicationPreferences.test.tsx'),
 ('write-inventory', 'scripts/fhir-read-grant-check.ts', '  { path: "mcp/src/index.ts", line: 7945, callee: "fhir.patch", resourceType: "AccessPolicy", reason: "Policy sync uses the MCP process service client." },', '', 'FHIR read grant CLI passes', '../tests/preflight/fhir-read-grant-check.test.ts'),
]
results = []
for name, path, old, new, pattern, *tests in cases:
    target = checkout / path
    original = target.read_bytes()
    text = original.decode()
    assert text.count(old) == 1, (name, text.count(old))
    changed = text.replace(old, new)
    (evidence / f'{name}.diff.gz').write_bytes(gzip.compress(''.join(difflib.unified_diff(text.splitlines(True), changed.splitlines(True), fromfile=path, tofile=path)).encode(), mtime=0))
    prefix = 'ui' if name == 'ui-disclosure' else 'mcp'
    # UI package's fixed glob requires invoking the same Node/tsx runner with a narrow selection.
    command = ['node', '--import', 'tsx', '--test', '--test-concurrency=1', f'--test-name-pattern={pattern}', *tests] if prefix == 'ui' else ['npm', 'test', '--', f'--test-name-pattern={pattern}', *tests]
    def run(state):
        log = evidence / f'{name}-{state}.log'
        with log.open('w') as output:
            output.write('cwd: ' + str(checkout / prefix) + '\ncommand: ' + json.dumps(command) + '\n')
            output.flush()
            process = subprocess.run(command, cwd=checkout / prefix, env={**os.environ, 'ODOS_POSTGRES_URL': 'postgresql://medplum:medplum@127.0.0.1:29433/medplum'}, stdout=output, stderr=subprocess.STDOUT)
        log.write_text('\n'.join(line.rstrip() for line in log.read_text().splitlines()).rstrip() + '\n')
        import re
        summary = dict(re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', log.read_text(), re.M))
        return {'exit': process.returncode, **summary, 'log': log.name}
    try:
        target.write_text(changed)
        broken = run('broken')
    finally:
        target.write_bytes(original)
    restored = run('restored')
    assert target.read_bytes() == original
    result = {'guard': name, 'source': path, 'sourceSha256': hashlib.sha256(original).hexdigest(), 'command': command, 'broken': broken, 'restored': restored}
    results.append(result)
    (evidence / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    assert broken['exit'] != 0 and int(broken.get('fail', 0)) > 0, f'{name}: mutation did not demonstrate a failing test'
    assert restored['exit'] == 0 and int(restored.get('pass', 0)) > 0, f'{name}: restored suite failed'
