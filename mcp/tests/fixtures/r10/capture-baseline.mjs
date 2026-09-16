import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';

const destination = process.env.R10_BASELINE_OUTPUT;
if (!destination) throw new Error('R10_BASELINE_OUTPUT must name a scratch output file.');
globalThis.__r10Capture = (kind, args, result) => {
  appendFileSync(destination, JSON.stringify({ suite: process.argv.at(-1)?.split('/').at(-1), kind, args, result },
    (_key, value) => value instanceof Map ? { entries: [...value] } : value) + '\n');
};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes('/src/clinical-graph/') || !loaded.source) return loaded;
    let source = loaded.source.toString();
    for (const [file, names] of Object.entries({
      'diagnosis-findings-endpoint': ['atomicFindingRows', 'sectionFindingRows'],
      'exam-overview-projection': ['buildExamOverviewProjection'],
      'diagnosis-candidates-endpoint': ['findingInstancesFromObservation'],
      'diagnosis-completeness-endpoint': ['keyFindingSatisfied'],
    })) {
      if (!url.includes(`/${file}.`)) continue;
      for (const name of names) {
        const pattern = new RegExp(`(export\\s+)?function ${name}\\(`);
        const declaration = source.match(pattern);
        if (!declaration) throw new Error(`Cannot instrument ${name}`);
        const exported = declaration[1] ? "export " : "";
        source = source.replace(pattern, `function __r10_${name}(`);
        source += `\n${exported}function ${name}(...args) { const result = __r10_${name}(...args); globalThis.__r10Capture(${JSON.stringify(name)}, args, result); return result; }\n`;
      }
    }
    if (url.includes('/custom-section-endpoint.')) {
      const marker = /return\s*\{\s*status:\s*200,\s*body:\s*\{\s*rows\s*\}\s*\}/;
      if (!marker.test(source)) throw new Error('Cannot instrument history return');
      source = source.replace(marker, (matched) => `globalThis.__r10Capture('history', [definition, bundle, input], {status: 200, body: {rows}}); ${matched}`);
    }
    return { ...loaded, source };
  },
});
