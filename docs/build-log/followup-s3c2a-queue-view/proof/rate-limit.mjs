import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const runtime = '.odos/s3c2a-proof';
const { ports, project } = JSON.parse(readFileSync(`${runtime}/manifest.json`, 'utf8'));
assert.equal(project, 'odos-s3c2a-proof');
const { visits } = JSON.parse(readFileSync(`${runtime}/queue-visits.json`, 'utf8'));
const statuses = [];
const started = performance.now();
for (let i = 0; i < 121; i++) {
  const response = await fetch(`http://127.0.0.1:${ports.frontdoor}/clinical-graph/encounters/${visits.glaucoma}/follow-up-queue`);
  statuses.push(response.status);
  await response.arrayBuffer();
}
assert.ok(performance.now() - started < 60_000, 'All requests must fit within one limiter window');
assert.deepEqual(statuses, [...Array(120).fill(401), 429], 'Run first after starting a fresh proof server');
const result = { syntheticOnly: true, requests: statuses.length, firstStatus: statuses[0], lastStatus: statuses.at(-1), counts: Object.fromEntries([401, 429].map(status => [status, statuses.filter(s => s === status).length])) };
writeFileSync('docs/build-log/followup-s3c2a-queue-view/rate-limit-proof.json', JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result));
