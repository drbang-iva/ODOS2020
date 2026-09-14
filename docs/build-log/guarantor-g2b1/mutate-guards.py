#!/usr/bin/env python3
"""Author-side source mutations in a disposable copy; never edits the served tree."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = 'mcp/src/clinic/guarantor-link-operation.ts'
parser = argparse.ArgumentParser()
parser.add_argument('--only', default='')
parser.add_argument('--output', default=str(ROOT / '.odos/g2b1-build/core-mutations'))
args = parser.parse_args()
OUT = Path(args.output).resolve()
OUT.mkdir(parents=True, exist_ok=True)

def edit(text, old, new, count=1):
    assert text.count(old) == count, f'Expected {count} exact source anchors: {old[:100]}'
    return text.replace(old, new)

def replace(old, new, count=1):
    return lambda s: edit(s, old, new, count)

def chain(*edits):
    def apply(s):
        for change in edits:
            s = change(s)
        return s
    return apply

def skip_claims(s):
    begin = s.index('  async original(): Promise<void> {')
    end = s.index('  async checkCorrections()', begin)
    return s[:begin] + '  async original(): Promise<void> { await this.move(); }\n' + s[end:]

def attach_first(s):
    begin = s.index('    if (linkedIds(this.loaded.source).some(id => pendingIds.includes(id)))')
    end = s.index('    const attach = ', begin)
    block = s[begin:end]
    s = s[:begin] + s[end:]
    point = s.index('    await this.projectAndRelease();')
    s = s[:point] + block + s[point:]
    return edit(s, 'if (owners.some(p => p.id !== destination.id)) return this.pause("interfered", `RelatedPerson/${id}`);', '')

def classify_after_fence(s):
    s = edit(s, 'fenced(current), intent?.expectedVersion ?? version(current)', 'fenced(current), version(current)')
    return edit(s, 'if (intent) await this.resolve(intent, "not-landed");', 'if (intent) { const after = await this.operation.read<Person>("Person", current.id!); if (guarantorContentHash(after) !== intent.intendedContentHash) return this.pause("interfered", intent.target); await this.resolve(intent, "landed"); }')

def epoch_comparator(s):
    helper = '\nfunction epochHash(resource: Resource): string { const { meta: _meta, ...body } = resource; return createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex"); }\n'
    s += helper
    s = s.replace('guarantorContentHash(fresh) !== intent.intendedContentHash', 'epochHash(fresh) !== intent.intendedContentHash')
    return s.replace('guarantorContentHash(after) !== intent.intendedContentHash', 'epochHash(after) !== intent.intendedContentHash')

def case(name, pattern, transform, file=SOURCE, command=None, cwd='mcp'):
    return dict(name=name, pattern=pattern, transform=transform, file=file, command=command, cwd=cwd)

cases = [
    case('L1-claim-required', 'L1:', skip_claims),
    case('L2-sorted-claims', 'L2:', replace('async original(): Promise<void> {\n    for (const id of [...this.plan.relatedPersonIds].sort())', 'async original(): Promise<void> {\n    for (const id of this.plan.relatedPersonIds)')),
    case('L3a-pending-after-detach', 'L3:', replace('return this.pause("attach-pending", reference(destination));', 'await this.checkpointTask("failed", "attach-conflict"); throw new Paused("attach-conflict");')),
    case('L3b-detach-first', 'L3:', attach_first),
    case('L5-generation', 'L5:', replace('if (version(currentDestination) !== version(destination)) return this.pause("project-pending", reference(destination));', '')),
    case('L6-destination-details', 'L6/L7/L8:', replace('const projected = { ...child, ...projectResponsiblePartyDemographics(destination) };', 'const projected = { ...child, ...projectResponsiblePartyDemographics(this.loaded.source) };')),
    case('L6-retain-source', 'L6/L7/L8:', replace('request: { method, url:', 'request: { method: phase === "detaching" ? "DELETE" : method, url:')),
    case('L7-child-extension-fence', 'L6/L7/L8:', replace('const projected = { ...child, ...projectResponsiblePartyDemographics(destination) };', 'const projected = { ...child, ...projectResponsiblePartyDemographics(destination), extension: [...(await this.operation.read<RelatedPerson>("RelatedPerson", "k")).extension ?? [], ...(child.extension ?? []).filter(e => e.url === GUARANTOR_CLAIM_URL)] };')),
    case('L7-child-active-fence', 'L6/L7/L8:', replace('const projected = { ...child, ...projectResponsiblePartyDemographics(destination) };', 'const projected = { ...child, ...projectResponsiblePartyDemographics(destination), active: destination.active };')),
    case('L8-write-set', 'L6/L7/L8:', replace('await this.projectAndRelease();', 'await this.operation.transaction(this.loaded.patients[0], "extra-patient", "PUT", version(this.loaded.patients[0])); await this.projectAndRelease();')),
    case('L9-expected-version', 'L9:', replace('if (plan.expected[reference(r)] !== version(r))', 'if (false)')),
    case('L10-complete-consolidation-set', 'L10:', replace('if (plan.kind === "consolidate" && !equalIds(sourceIds, plan.relatedPersonIds))', 'if (false)')),
    case('L11-practice-scope', 'L11:', replace('if (projectOf(r) !== this.project)', 'if (false)')),
    case('L12-landed-intent', 'L12/L14:', replace('await this.resolve(intent, "landed", fresh.meta?.author?.reference);', 'await this.resolve(intent, "not-landed"); await this.write("detaching", fresh, intent.expectedVersion);')),
    case('L13-interference', 'L13:', replace('else if (guarantorContentHash(child) === intent.intendedContentHash)', 'else if (true)')),
    case('L14a-full-old-comparator', 'L12/L14:', chain(classify_after_fence, epoch_comparator)),
    case('L14b-epoch-in-comparison', 'L12/L14:', epoch_comparator),
    case('L14c-classify-before-fence', 'L12/L14:', classify_after_fence),
    case('L15a-person-fence', 'L15: correction fences', replace('async correct(original: Task): Promise<void> {\n    await this.classifyAndFence();', 'async correct(original: Task): Promise<void> {')),
    case('L15b-cancel-last', 'L15/L24a/L25:', replace('async correct(original: Task): Promise<void> {\n    await this.classifyAndFence();', 'async correct(original: Task): Promise<void> {\n    await this.classifyAndFence(); await this.cancelOriginal();')),
    case('L15-fresh-retry-correction-check', 'L15 pre-takeover retry:', replace('const correction = await this.checkCorrections();\n      if (correction) throw new Paused(correction === "cancelled" ? "corrected" : "takeover-in-progress", reference(fresh));', '')),
    case('L16-release-required', 'L16/L20:', replace('for (const child of verified) {', 'for (const child of [] as RelatedPerson[]) {')),
    case('L17-moved-set-binding', 'L17:', replace(' && readPlan(task).relatedPersonIds.includes(child.id!)', '')),
    case('L19-action-required', 'L19:', replace('if (!staffHasBusinessAction(staff, "guarantor.link"))', 'if (false)')),
    case('L20-completed-audit-after-release', 'L16/L20:', replace('for (const child of verified) {', 'await this.audit("completed", "linked");\n    for (const child of verified) {')),
    case('L21-idempotency', 'L21:', replace('const existing = await operation.existing(plan.operationId); if (existing)', 'const existing = undefined; if (existing)')),
    case('L24-code-filter', 'L24 step 0:', chain(replace(', code: `${GUARANTOR_OPERATION_SYSTEM}|`', ''), replace(' && Boolean(task.code?.coding?.some(c => c.system === GUARANTOR_OPERATION_SYSTEM))', ''))),
    case('L24-service-authorship', 'L24 step 0:', replace(' && task.meta?.author?.reference === this.deps.serviceReference', '')),
    case('L24a-claim-descent', 'L15/L24a/L25:', replace('if (holder.status === "failed" || holder.status === "cancelled") return claimed(child, this.task.id!);', '')),
    case('L24b-step-zero-before-writes', 'L24b:', replace('async complete(): Promise<boolean> {\n    const correction', 'async complete(): Promise<boolean> {\n    await this.classifyAndFence();\n    const correction')),
    case('L24c-completed-correction', 'L24c:', replace('if (corrections.some(t => t.status === "completed"))', 'if (false)')),
    case('L25-live-correction-never-self-cancels', 'L15/L24a/L25:', replace('if (corrections.some(t => t.status === "in-progress")) return "pending";', 'if (corrections.some(t => t.status === "in-progress")) { await this.checkpointTask("cancelled", "corrected"); return "cancelled"; }')),
    case('L26-correction-detaches-current-owner', 'L26:', chain(replace('await this.detachCurrentOwners();', '', 2), replace('if (linkedIds(this.loaded.source).some(id => pendingIds.includes(id)))', 'if (this.plan.kind !== "correct" && linkedIds(this.loaded.source).some(id => pendingIds.includes(id)))'))),
    case('L27-terminal-rule-at-ownership-check', 'L27/L29:', replace('ownershipLanded(): boolean { return this.journal.intents.some(i => i.disposition === "landed" && ["detaching", "attaching", "projecting", "releasing"].includes(i.phase)); }', 'ownershipLanded(): boolean { return false; }')),
    case('L28-reclaim-checkpointed-claim', 'L28:', replace('if (!refs.length && checkpointed && !owners.length) return claimed(child, this.task.id!);', '')),
    case('L29-definite-response-intent-rule', 'L27/L29:|L29:|S3 intent rule:', replace('if (status) await this.checkpointResponse(intent, "rejected", status);', '')),
    case('S6-cancel-attempt-bound', 'S6 bounded cancellation:', replace('attempt < 3', 'attempt < 4')),
    case('S6-pending-takeover-prefix', 'S6 crash prefix:', replace('if (this.plan.kind === "correct" && !this.ownershipLanded()) {', 'if (false) {')),
    case('S3-post-release-activity', 'S3 released children:', replace('const pendingIds = this.plan.relatedPersonIds.filter(id => !this.released(id));', 'const pendingIds = this.plan.relatedPersonIds;')),
    case('S3-no-checkpoint-replay', 'S3 checkpoint refusal', replace('if (this.checkpointError) throw this.checkpointError.cause;', '', 2)),
    case('S5-fresh-claim-classification', 'S5 retry classification:', replace('if (phase !== "claiming") {\n        await this.resumeClaims();\n        if (resource.resourceType === "RelatedPerson") fresh = await this.operation.read<T>(resource.resourceType, resource.id!);\n      }', '')),
    case('S3-terminal-journal-checkpoint', 'L15: correction fences', replace('const fresh = await this.operation.read<Task>("Task", this.task.id!);', 'const fresh = this.task;')),
    case('S3-terminal-response-stops-runner', 'S3 late successful release', replace('if (fresh.status !== "in-progress") throw new Settled();', '')),
    case('S3-terminal-checkpoint-refusal', 'S3 terminal response checkpoint refusal', replace('if (run?.checkpointError) error = run.checkpointError.cause;', '')),
    case('S1-rate-limit', 'S1 rate limit:', replace(', limit, handle(', ', handle(', 5), file='mcp/src/clinic/guarantor-routes.ts', command=['node', '--import', 'tsx', '--test', '--test-name-pattern=S1 rate limit:', 'tests/guarantorLinkRoutes.test.ts']),

    case('Registry-service-write', '', lambda s: re.sub(r'^  \{ path: "mcp/src/clinic/guarantor-link-operation.ts",[^\n]+resourceType: "Task"[^\n]+\n', '', s, count=1, flags=re.M), file='scripts/fhir-read-grant-check.ts', command=['npm', 'run', 'preflight'], cwd='.'),
    case('Registry-audit-event', '', replace("'guarantor.link.started',", ''), file='data/migrations/2026-09-14-guarantor-link-events.sql', command=['node', '--import', 'tsx', '--test', 'tests/paymentAudit.test.ts']),
    case('Registry-canonical-extension', '', lambda s: json.dumps({**json.loads(s), 'extensions': [e for e in json.loads(s)['extensions'] if not e['url'].endswith('/guarantor-link-claim')]}, indent=2)+'\n', file='data/canonical-extensions/registry.json', command=['npm', 'run', 'preflight'], cwd='.'),
]

with tempfile.TemporaryDirectory(prefix='g2b1-mutants-', dir=ROOT / '.odos') as directory:
    copy = Path(directory)
    for name in ['mcp/src', 'mcp/tests', 'ui/src', 'ui/tests', 'src', 'scripts', 'data', 'policy', 'policies']:
        if (ROOT / name).exists():
            shutil.copytree(ROOT / name, copy / name)
    for name in ['package.json', 'tsconfig.scripts.json', 'mcp/package.json', 'ui/package.json', 'medplum.config.json', '.env.example']:
        if (ROOT / name).exists():
            shutil.copyfile(ROOT / name, copy / name)
    for name in ['node_modules', 'mcp/node_modules', 'ui/node_modules']:
        (copy / name).symlink_to(ROOT / name, target_is_directory=True)
    def run_case(item, stage):
        command = item['command'] or ['node', '--import', 'tsx', '--test', '--test-name-pattern=' + item['pattern'], 'tests/guarantorLinkOperation.test.ts']
        result = subprocess.run(command, cwd=copy / item['cwd'], text=True, capture_output=True, timeout=30)
        output = result.stdout + result.stderr
        (OUT / f"{item['name']}-{stage}.log").write_text(output)
        failed = re.findall(r'^not ok \d+ - (.+)$', output, re.M)
        counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', output, re.M)}
        return {'exit': result.returncode, 'failingTests': failed, 'counts': counts, 'namedTests': [name for name in re.findall(r'^# Subtest: (.+)$', output, re.M) if not name.startswith('tests/')]} 
    results = []
    for item in cases:
        if args.only and item['name'] not in args.only.split(','):
            continue
        file = copy / item['file']
        original = file.read_text()
        green = run_case(item, 'green')
        assert green['exit'] == 0 and (item['command'] or green['namedTests']), (item['name'], 'baseline failed or no named test ran', green)
        changed = item['transform'](original)
        assert changed != original
        try:
            file.write_text(changed)
            red = run_case(item, 'red')
        finally:
            file.write_text(original)
        restored = run_case(item, 'restored')
        row = {'guard': item['name'], 'source': item['file'], 'sourceSha256': hashlib.sha256(original.encode()).hexdigest(), 'mutatedSha256': hashlib.sha256(changed.encode()).hexdigest(), 'green': green, 'red': red, 'restored': restored, 'killed': red['exit'] != 0 and bool(red['failingTests'] or item['command']) and restored['exit'] == 0}
        results.append(row)
        (OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(item['name'], 'KILLED' if row['killed'] else 'SURVIVED', red['failingTests'], flush=True)
    assert all(item['killed'] for item in results), 'At least one mutation survived; inspect results.json'
