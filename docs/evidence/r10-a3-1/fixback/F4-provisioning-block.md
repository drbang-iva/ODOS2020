# F4 provisioning boundary awaiting operator ruling

The lane was built on fresh Medplum5.1.30 at localhost:18103, with bootstrap12/12 and integration218/218, operator-identity, repair-practice-roles (MEDPLUM_CONTRACT_BOOTSTRAP=1, GITHUB_ACTIONS=true), then sync --apply --bootstrap-service-identity. Repair bound the lane admin to its canonical practice-role policy, as required.

The operator seeder token cannot provision an administrative service membership:

1. POST /admin/projects/<synthetic-project>/client:403. [Full live lane71/73](F4-admin-api-refusal.txt), failing at the creation status assertion, before any MCP lifecycle operation.
2. Seeder FHIR ClientApplication create succeeds, but POST /fhir/R4/ProjectMembership:403. [Focused live2/4](ocular-initial.txt), again before lifecycle operations. Created application was cleaned up by the test.

A clarification was requested because F4 explicitly requires provisioning “through the seeder.” The proposed alternative is to use the lane's existing project-admin credentials only for administrative creation, preserve its policy bindings, and run lifecycle checks exclusively under the newly created disposable project-admin ClientApplication with no policy and no super-admin identity. No such alternative has yet been applied.

No policy, service-authentication module, project feature, shared account or deployed system was changed. Current F4 implementation is preserved but is not passing and must not be represented as verified.
