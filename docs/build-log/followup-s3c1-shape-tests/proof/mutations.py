from pathlib import Path
import json, re, subprocess

root = Path(__file__).resolve().parents[4]
store = root / 'mcp/src/clinical-graph/exam-scope-store.ts'
endpoint = root / 'mcp/src/clinical-graph/exam-overview-endpoint.ts'
original = store.read_text()
endpoint_original = endpoint.read_text()

def run(pattern, test_file='mcp/tests/examShapeRecord.test.ts'):
    command = ['node', '--import', 'tsx', '--test', '--test-name-pattern=' + pattern, test_file]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True)
    summary = '\n'.join(line for line in result.stdout.splitlines() if re.match(r'^(?:not )?ok |^# (tests|pass|fail|cancelled|skipped|todo) ', line))
    return {'command': ' '.join(command), 'exit': result.returncode, 'summary': summary}

live_read = '''if (resource) {
      const shape = parseScope(resource);
      const { FhirFollowUpProfileStore } = await import("./follow-up-profile-store.js");
      const profiles = (await new FhirFollowUpProfileStore(this.fhir).list()).filter(profile => profile.active && shape.profilesApplied?.some(applied => applied.profileKey === profile.profileKey));
      return { ...shape, testsProposed: profiles.flatMap(profile => profile.testsQueuedByDefault.map(test => ({ orderable: test.orderable, ...(test.focus ? { focus: test.focus } : {}), sources: [{ kind: "profile" as const, profileKey: profile.profileKey }] }))) };
    }
    return { examScope: "comprehensive" };'''
mutations = [
    ('G1', original.replace('return resource ? parseScope(resource) : { examScope: "comprehensive" };', live_read)),
    ('G2', original.replace('`${test.orderable}|${test.focus ?? ""}`', 'test.orderable')),
    ('G3', original.replace('return [...merged.values()];', 'return [...merged.values()].map(test => ({ ...test, sources: [] }));')),
    ('G4', original.replace('testsProposed: z.array(proposedTestSchema).optional()', 'testsProposed: z.array(proposedTestSchema)')),
    ('G5', original[:original.index('  async pick(')] + original[original.index('  async pick('):].replace('testsProposed: mergeProposedTests(testsProposed)', 'testsProposed: []', 1)),
    ('G7', original.replace('    if (existing) return parseScope(existing);\n', '')),
]
results = []
try:
    for guard, mutated in mutations:
        assert mutated != original, guard
        store.write_text(mutated)
        pattern = 'S3c1 ' + guard + ('|S3b2 G1' if guard == 'G7' else '')
        red = run(pattern)
        store.write_text(original)
        green = run(pattern)
        results.append({'guard': guard, 'red': red, 'green': green})
        assert red['exit'] != 0 and '# fail 0' not in red['summary'], (guard, red)
        assert green['exit'] == 0 and '# fail 0' in green['summary'], (guard, green)
    mutated = endpoint_original.replace('// Optional test resolution must not discard the rest of the encounter shape.', 'throw new Error("synthetic test resolution becomes fatal");')
    assert mutated != endpoint_original
    endpoint.write_text(mutated)
    red = run('S3c1 unresolved tests', 'mcp/tests/examOverviewEndpoint.test.ts')
    endpoint.write_text(endpoint_original)
    green = run('S3c1 unresolved tests', 'mcp/tests/examOverviewEndpoint.test.ts')
    results.append({'guard': 'best-effort additional guard', 'red': red, 'green': green})
    assert red['exit'] != 0 and green['exit'] == 0
finally:
    store.write_text(original)
    endpoint.write_text(endpoint_original)
    (root / 'docs/build-log/followup-s3c1-shape-tests/mutations.json').write_text(json.dumps(results, indent=2) + '\n')
for row in results:
    print(row['guard'])
    print('RED (exit %s)\n%s' % (row['red']['exit'], row['red']['summary']))
    print('GREEN (exit %s)\n%s' % (row['green']['exit'], row['green']['summary']))
