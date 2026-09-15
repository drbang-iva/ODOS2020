import { resolveDiagnosisDxKeys } from '../diagnosis-dx-key-resolver.js';
import { loadDefaultEducationCatalogReader, type EducationCatalogReader } from '../../comms/education-catalog.js';
import type { ProtocolDefinition, ProtocolItem } from '../protocol-types.js';
import type { PlanSetSpec, HiddenPlanSetItem } from './types.js';
export type { PlanSetSpec, HiddenPlanSetItem } from './types.js';
const defaults = { defaultSelected: true, lateralityMode: 'inherit-dx' as const };
export function buildPlanSetProtocols(specs: readonly PlanSetSpec[], orderableKeys: ReadonlySet<string>, catalog: EducationCatalogReader = loadDefaultEducationCatalogReader()): { protocols: ProtocolDefinition[]; hidden: HiddenPlanSetItem[] } {
  const hidden: HiddenPlanSetItem[] = [];
  const protocols = specs.map(spec => {
    if (JSON.stringify(spec).includes('"finding-seed"')) throw new Error('Plan sets refuse finding-seed items.');
    const dxKeys = [...new Set(spec.families.flatMap(family => {
      const result = resolveDiagnosisDxKeys(family);
      if (result.status === 'unresolved' || !result.dxKeys.length) throw new Error(`Unresolved diagnosis family: ${family}`);
      return result.dxKeys;
    }))].sort();
    const items: ProtocolItem[] = [];
    const concepts = new Set<string>();
    const identities = new Set<string>();
    const focuses = new Set<string>();
    for (const t of spec.tests) {
      if (!orderableKeys.has(t.orderable)) {
        hidden.push({planSetKey:spec.key,kind:'test',title:t.title,orderable:t.orderable,reason:'not-orderable'});
        continue;
      }
      const focusIdentity = `${t.orderable}:${slug(t.focus ?? '')}`;
      if (focuses.has(focusIdentity)) throw new Error(`Duplicate test focus: ${t.orderable}`);
      focuses.add(focusIdentity);
      const suffix = concepts.has(t.orderable) ? slug(t.focus ?? '') : '';
      if (concepts.has(t.orderable) && !suffix) throw new Error(`Repeated test requires distinct focus: ${t.orderable}`);
      const itemKey = `order-${t.orderable}${suffix ? `-${suffix}` : ''}`;
      if (identities.has(itemKey)) throw new Error(`Duplicate plan item: ${itemKey}`);
      identities.add(itemKey);
      items.push({...defaults,lateralityMode:'OU-always',itemKey,itemType:'order',title:t.title,mergeKey:`order:${t.orderable}${suffix ? `:${suffix}` : ''}`,...(t.procedureDefinitionKey ? {procedureDefinitionKey:t.procedureDefinitionKey} : {}),payload:{orderableKey:t.orderable,performContext:t.performContext,...(t.focus ? {focus:t.focus} : {}),chargeSeedRef:`charge-${t.orderable}`}});
      if (!concepts.has(t.orderable)) {
        // Recorded data only; requiresOrderCompletion is not an execution gate.
        items.push({...defaults,itemKey:`charge-${t.orderable}`,itemType:'charge-seed',title:`${t.title} charge`,payload:{procedureConceptKey:t.orderable,chargeRuleRefs:[`rule-${t.orderable}-glaucoma`],requiresOrderCompletion:true}});
      }
      concepts.add(t.orderable);
    }
    for (const c of spec.counseling) items.push({...defaults,itemKey:`counsel-${c.topicKey}`,itemType:'counseling',title:c.title,mergeKey:`counseling:${c.topicKey}`,payload:{topicKey:c.topicKey,narrativeTemplate:c.narrativeTemplate}});
    for (const h of spec.handouts) {
      const entry = h.assetRef ? catalog.get(h.assetRef) : undefined;
      const urls = Object.values(entry?.urls ?? {}).filter((url): url is string => Boolean(url));
      if (!entry || !catalog.placeholderUrlHost || !urls.length || urls.some(url => new URL(url).hostname === catalog.placeholderUrlHost)) {
        hidden.push({planSetKey:spec.key,kind:'handout',title:h.title,...(h.assetRef ? {assetRef:h.assetRef} : {}),reason:'handout — no real catalog content'});
        continue;
      }
      items.push({...defaults,itemKey:`education-${entry.id}`,itemType:'education',title:entry.title,payload:{assetRef:entry.id,deliveryMode:'print',note:'Handout recorded; delivery is not yet tracked'}});
    }
    const {title,...followUp} = spec.followUp;
    items.push({...defaults,itemKey:'follow-up',itemType:'follow-up',title,mergeKey:'followup',payload:{...followUp,schedulingOrder:true}});
    const at='2026-09-15T00:00:00.000Z';
    return {id:spec.replaces?.id ?? spec.key,version:spec.version,title:spec.title,trigger:{kind:'diagnosis' as const,dxKeys},ownership:{ownerId:'practice',sharing:'practice'},categories:['Glaucoma'],status:'active' as const,items,provenanceNote:spec.source.note,authoring:{origin:'clinician' as const,at,actor:'Practitioner/odos-system'},audit:{createdBy:'Practitioner/odos-system',createdAt:at,publishedBy:'Practitioner/odos-system',publishedAt:at}};
  });
  return { protocols, hidden };
}
function slug(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
