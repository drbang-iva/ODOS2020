export function generateCaddyfile(source, ports) {
  for (const value of Object.values(ports)) {
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Harness ports must be unprivileged TCP ports.');
  }
  return source.replace(/^:8090 \{/m, `:${ports.frontdoor} {`)
    .replaceAll('127.0.0.1:8103', `127.0.0.1:${ports.medplum}`)
    .replaceAll('127.0.0.1:3333', `127.0.0.1:${ports.proxy}`);
}

export function assertCaddyParity(source, generated, ports) {
  const expected = generateCaddyfile(source, ports).split('\n');
  const actual = generated.split('\n');
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    if (actual[index] !== expected[index]) throw new Error(`Caddyfile differs beyond allowed port substitutions at line ${index + 1}: expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])}`);
  }
}
