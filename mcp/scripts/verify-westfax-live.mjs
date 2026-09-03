import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { getWestFaxInboundDescriptions, westFaxInboundLookbackDays, WESTFAX_BASE_URL } =
  await tsImport("../src/fax/westfax-adapter.ts", import.meta.url);

export async function verifyWestFaxLive(env, fetchImpl = fetch) {
  const required = ["WESTFAX_USERNAME", "WESTFAX_PASSWORD", "WESTFAX_PRODUCT_ID"];
  if (required.some((name) => !env[name]?.trim())) {
    throw new Error("WESTFAX_USERNAME, WESTFAX_PASSWORD, and WESTFAX_PRODUCT_ID must be set in the environment.");
  }
  const inboundLookbackDays = westFaxInboundLookbackDays(env.WESTFAX_INBOUND_LOOKBACK_DAYS);
  try {
    return await getWestFaxInboundDescriptions({
      username: env.WESTFAX_USERNAME.trim(),
      password: env.WESTFAX_PASSWORD,
      productId: env.WESTFAX_PRODUCT_ID.trim(),
      baseUrl: env.WESTFAX_BASE_URL || WESTFAX_BASE_URL,
      inboundLookbackDays,
    }, { fetchImpl });
  } catch {
    // Vendor and transport errors may echo submitted credentials.
    throw new Error("WestFax verification failed; check configuration and connectivity locally. Provider details were suppressed.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyWestFaxLive(process.env), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
