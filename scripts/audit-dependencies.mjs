import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = ['.', 'mcp'];
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
try {
  const allowlist = JSON.parse(readFileSync(resolve(root, 'security/audit-allowlist.json'), 'utf8'));
  if (!Array.isArray(allowlist)) throw new Error('Audit allowlist must be an array');
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of allowlist) {
    if (!entry || !/^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.ghsa) ||
        typeof entry.package !== 'string' || !entry.package.trim() ||
        typeof entry.reason !== 'string' || !entry.reason.trim() ||
        typeof entry.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy) ||
        !Number.isFinite(Date.parse(entry.reviewBy)) || new Date(entry.reviewBy).toISOString().slice(0, 10) !== entry.reviewBy) {
      throw new Error('Invalid audit allowlist entry');
    }
    if (entry.reviewBy < today) throw new Error(`Audit allowlist expired: ${entry.ghsa} ${entry.package} (${entry.reviewBy})`);
  }
  let blocked = false;
  for (const manifest of manifests) {
    const result = spawnSync('npm', ['audit', '--audit-level=high', '--omit=dev', '--json'], {
      cwd: resolve(root, manifest), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`npm audit failed for ${manifest}: ${result.error?.message || `exit ${result.status}`}`);
    const report = JSON.parse(result.stdout);
    if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities ||
        Array.isArray(report.vulnerabilities) || typeof report.vulnerabilities !== 'object') {
      throw new Error(`Invalid npm audit report for ${manifest}`);
    }
    const counts = Object.fromEntries(severities.map(s => [s, 0]));
    for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (!vulnerability || !severities.includes(vulnerability.severity) || (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0)) throw new Error(`Invalid audit vulnerability: ${name}`);
      counts[vulnerability.severity]++;
      for (const advisory of vulnerability.via) {
        if (typeof advisory === 'string') {
          if (!Object.hasOwn(report.vulnerabilities, advisory)) throw new Error(`Missing audit dependency: ${advisory}`);
          continue;
        }
        const ghsa = typeof advisory?.url === 'string' && advisory.url.match(/^https:\/\/github\.com\/advisories\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/)?.[1];
        if (!ghsa || !severities.includes(advisory.severity) || typeof advisory.name !== 'string') throw new Error(`Invalid audit advisory: ${name}`);
        const accepted = allowlist.some(entry => entry.ghsa === ghsa && entry.package === advisory.name);
        console.log(`${manifest}: ${advisory.name} ${advisory.severity} ${ghsa}${accepted ? ' (allowlisted)' : ''}`);
        if (['high', 'critical'].includes(advisory.severity) && !accepted) blocked = true;
      }
    }
    console.log(`${manifest}: ${JSON.stringify(counts)}`);
  }
  process.exitCode = blocked ? 1 : 0;
} catch (error) {
  console.error(`AUDIT GATE: ${error.message}`);
  process.exitCode = 1;
}
