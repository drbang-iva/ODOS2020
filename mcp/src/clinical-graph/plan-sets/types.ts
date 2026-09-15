export interface PlanSetSpec {
  key: string;
  version: number;
  title: string;
  families: string[];
  replaces?: { id: string };
  tests: Array<{ title: string; orderable: string; performContext: 'in-office-today' | 'schedule'; focus?: string; procedureDefinitionKey?: string }>;
  counseling: Array<{ title: string; topicKey: string; narrativeTemplate: string }>;
  handouts: Array<{ title: string; assetRef?: string }>;
  followUp: { title: string; interval: number; unit: 'weeks' | 'months'; reason: string; followUpKind: 'medical' };
  source: { eyefinity: boolean; note: string };
}
export interface HiddenPlanSetItem {
  planSetKey: string;
  kind: 'test' | 'handout';
  title: string;
  orderable?: string;
  assetRef?: string;
  reason: 'not-orderable' | 'handout — no real catalog content';
}
