import type { AtomicFindingCatalogRow } from "../../../src/clinical-graph/diagnosis-findings-endpoint.js";
import type { CurrentFindingProjection } from "../../../src/clinical-graph/current-finding-reader.js";

export function compatRows(projection: CurrentFindingProjection) {
  return projection.currentFacts.filter(f=>f.status==="live").flatMap(f=>f.contributors.map(c=>({
    atomicFindingId:`${f.key.stableKey}::${f.key.fieldCode}::${f.key.optionCode}`,
    presence:f.presence, laterality:f.eye, ...(typeof f.qualifiers.grade === "string" ? {grade:f.qualifiers.grade}:{}),
    source:c.kind==="legacy-section-snapshot"?"section":"atomic", observationReference:c.reference,
    ...(f.homes.length===1?{conditionReference:f.homes[0]}:{}),
  })));
}
export function rowContract(rows: any[]) {
  return rows.map(({atomicFindingId,presence,laterality,grade,source,observationReference,conditionReference})=>
    ({atomicFindingId,presence,laterality,...(grade?{grade}:{}),source,observationReference,...(conditionReference?{conditionReference}:{})}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
