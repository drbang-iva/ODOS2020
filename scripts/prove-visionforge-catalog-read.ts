import { createEducationCatalogFromEnv } from "../mcp/src/comms/visionforge-education-catalog.js";

const catalog = createEducationCatalogFromEnv(process.env);
try {
  await catalog.ready();
  console.log(JSON.stringify({ phase: "before", ...catalog.status() }));
  await catalog.refresh();
  console.log(JSON.stringify({ phase: "after", ...catalog.status() }));
} finally {
  await catalog.close();
}
