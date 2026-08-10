import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const ABSOLUTE_HTTP_URL = /https?:\/\/[^\s"'`<>\\)]+/gi;

function isLoopbackUrl(candidate: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) return true;

  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (!mappedIpv4) return false;
  const address = Number.parseInt(mappedIpv4[1], 16) * 65536 + Number.parseInt(mappedIpv4[2], 16);
  return Math.floor(address / 0x1000000) === 127;
}

async function outputFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return outputFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }));
  return files.flat();
}

export function loopbackBuildGuardPlugin(): Plugin {
  return {
    name: "odos-loopback-build-guard",
    apply: "build",
    async writeBundle(options) {
      if (!options.dir) throw new Error("Loopback build guard requires an output directory");
      const findings: string[] = [];

      for (const file of await outputFiles(options.dir)) {
        const contents = (await readFile(file)).toString("utf8");
        const urls = [...new Set((contents.match(ABSOLUTE_HTTP_URL) || []).filter(isLoopbackUrl))];
        for (const url of urls) findings.push(`${path.relative(options.dir, file)}: ${url}`);
      }

      if (findings.length > 0) {
        throw new Error(`Production build contains viewer-local loopback URLs:\n${findings.join("\n")}`);
      }
    },
  };
}
