import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const source = join(root, 'docs/build-log/followup-s2a-exam-scope/proof');
const generated = join(root, '.odos/email-e1a-proof-scripts');
mkdirSync(generated, { recursive: true, mode: 0o700 });
for (const name of ['stack.mjs', 'bootstrap.ts', 'seed-ui.ts', 'verify-ready.ts']) {
  let text = readFileSync(join(source, name), 'utf8')
    .replaceAll('odos-s2a-proof', 'odos-email-e1a-proof')
    .replaceAll('.odos/s2a-proof', '.odos/email-e1a-proof')
    .replaceAll('10.249.159.0/24', '10.249.162.0/24')
    .replaceAll('R10 A3.2 Synthetic Served Proof', 'E1a Synthetic Practice')
    .replaceAll('R10 Synthetic', 'E1a Synthetic')
    .replaceAll('Synthetic Served Proof', 'Synthetic Email Proof')
    .replaceAll("from '../../../../", "from '../../")
    .replaceAll("'docs/build-log/followup-s2a-exam-scope/proof/", "'.odos/email-e1a-proof-scripts/");
  if (name === 'stack.mjs') {
    text = text.replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');", `const root = ${JSON.stringify(root)};`)
      .replace('frontdoor: 31090, medplum: 31103, postgres: 28433, redis: 29380, mcp: 26334, proxy: 26335, control: 26336',
        'frontdoor: 32190, medplum: 32103, postgres: 29433, redis: 30380, mcp: 27334, proxy: 27335, control: 27336')
      .replace("ODOS_MCP_TRANSPORT: 'sse',", `ODOS_PRACTICE_NAME: 'E1a Synthetic Practice', ODOS_PRACTICE_POSTAL_ADDRESS: '100 Example Street, Test City, NY 10001', ODOS_PRACTICE_PHONE: '+12025550101', ODOS_COMMS_EMAIL_PROVIDER: 'google-workspace', GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL: 'synthetic@synthetic.iam.gserviceaccount.com', GOOGLE_WORKSPACE_PRIVATE_KEY: readFileSync(smartKeyPath, 'utf8'), GOOGLE_WORKSPACE_DELEGATED_USER: 'care@synthetic.example', GOOGLE_WORKSPACE_DOMAIN: 'synthetic.example', GOOGLE_WORKSPACE_FROM_ADDRESS: 'care@synthetic.example', GOOGLE_WORKSPACE_PLAN_CONFIRMED: 'true', ODOS_MCP_TRANSPORT: 'sse',`);
  }
  writeFileSync(join(generated, name), text);
}
console.log('Generated E1a-only harness from existing served-route proof; ports 32190/32103/29433/30380/27334-27336.');
