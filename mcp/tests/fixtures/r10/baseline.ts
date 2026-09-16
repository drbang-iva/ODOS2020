import { readFileSync } from "node:fs";
const packed = JSON.parse(readFileSync(new URL("./legacy-baseline.json", import.meta.url), "utf8"));
function unpack(value: any): any {
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") return "$ref" in value ? unpack(packed.pool[value.$ref]) : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unpack(v)]));
  return value;
}
export const baseline = unpack(packed.root) as { sourceHead: string; suiteHashes: Record<string,string>; captures: Array<{suite:string;kind:string;args:any[];result:any}> };
