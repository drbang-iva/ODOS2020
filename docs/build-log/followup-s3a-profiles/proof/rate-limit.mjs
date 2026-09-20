import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const { project, ports } = JSON.parse(readFileSync('.odos/s3a-proof/manifest.json', 'utf8'));
assert.equal(project, 'odos-s3a-proof');
const routes = [['GET', '/follow-up-profiles'], ['POST', '/follow-up-profiles'], ['POST', '/follow-up-profiles/glaucoma']];
async function request([method, path]) {
  const response = await fetch(`http://127.0.0.1:${ports.frontdoor}${path}`, { method });
  await response.arrayBuffer();
  return { method, path, status: response.status, rateLimit: response.headers.get('ratelimit'), retryAfter: response.headers.get('retry-after') };
}
const initial = [];
for (const route of routes) { const response = await request(route); initial.push(response); assert.equal(response.status, 401); }
let throttled = false;
for (let index = 0; index < 121; index++) {
  const response = await request(routes[0]);
  if (response.status === 429) { throttled = true; break; }
  assert.equal(response.status, 401);
}
assert.ok(throttled, 'Profile requests must reach 429 within 121 attempts');
const limited = [];
for (const route of routes) {
  const response = await request(route); limited.push(response);
  assert.equal(response.status, 429); assert.ok(response.rateLimit); assert.ok(response.retryAfter);
}
writeFileSync('docs/build-log/followup-s3a-profiles/rate-limit.json', JSON.stringify({ initial, limited }, null, 2) + '\n');
console.log('All three profile routes: unauthenticated 401 before limit; 429 with rate-limit/retry headers at limit.');
