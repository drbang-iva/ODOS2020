import { registerHooks } from 'node:module';

// Test-only access to the real private predicate; production exports remain unchanged.
const hook = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes('/clinical-graph/diagnosis-completeness-endpoint.') || !loaded.source) return loaded;
    const source = loaded.source.toString();
    if (!/function keyFindingSatisfied\(/.test(source)) throw new Error('Completeness predicate not found');
    return { ...loaded, source: `${source}\nexport { keyFindingSatisfied as r10KeyFindingSatisfied };\n` };
  },
});
export const { r10KeyFindingSatisfied: keyFindingSatisfied } = await import('../../../src/clinical-graph/diagnosis-completeness-endpoint.ts');
hook.deregister();
