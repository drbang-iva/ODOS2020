from pathlib import Path
import subprocess
root = Path.cwd()
endpoint = root/'mcp/src/clinical-graph/protocol-endpoint.ts'
service = root/'mcp/src/clinical-graph/protocol-service.ts'
originals = {p:p.read_text() for p in [endpoint,service]}
cmd = ['npm','--prefix','mcp','test','--','src/__tests__/plan-carried.test.ts']
def run(name):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (root/f'outputs/plan-authoring/{name}.txt').write_text(result.stdout)
    print(name, result.returncode, [line for line in result.stdout.splitlines() if line.startswith(('# pass ', '# fail '))])
    return result.returncode
def restore():
    for p,s in originals.items(): p.write_text(s)
try:
    for p in originals:
        p.write_text(subprocess.check_output(['git','show',f'bac7cd14:{p.relative_to(root)}'],text=True))
    assert run('carried-red') != 0
    restore()
    mapping = '''    if (error instanceof ProtocolItemAddConflictError) {
      return { status: 409, body: { error: error.message } };
    }
'''
    assert mapping in originals[endpoint]
    endpoint.write_text(originals[endpoint].replace(mapping,'',1))
    assert run('carried-mutation-apply-409') != 0
    restore(); assert run('carried-restored-apply-409') == 0
    endpoint.write_text(originals[endpoint].replace('error instanceof AcceptedChargeUnapplyError || error instanceof ProtocolItemAddConflictError','error instanceof AcceptedChargeUnapplyError'))
    assert run('carried-mutation-unapply-409') != 0
    restore(); assert run('carried-restored-unapply-409') == 0
    text=originals[service]
    a=text.index('    return this.encounterLock.run(encounterId, async () => {',text.index('  async confirmFollowUp('))
    b=text.index('      const payload =',a)
    old=text[a:b]
    replacement=old.replace('    return this.encounterLock.run(encounterId, async () => {\n','')+'    return this.encounterLock.run(encounterId, async () => {\n'
    service.write_text(text[:a]+replacement+text[b:])
    assert run('carried-mutation-confirm-lock') != 0
    restore(); assert run('carried-restored-confirm-lock') == 0
    service.write_text(originals[service].replace('payload.needsConfirmation = clinicianOwned && action.payload.needsConfirmation === false ? false : true','payload.needsConfirmation = true'))
    assert run('carried-mutation-undo-flag') != 0
    restore(); assert run('carried-restored-undo-flag') == 0
    endpoint.write_text(originals[endpoint].replace('await updateProjected(fhir, resourceType, id, resource, { "If-Match": `W/"${revokedVersion}"` })','await updateProjected(fhir, resourceType, id, resource)'))
    assert run('carried-mutation-restore-if-match') != 0
    restore(); assert run('carried-restored-restore-if-match') == 0
finally:
    restore()
