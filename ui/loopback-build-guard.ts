import type { OutputAsset, OutputChunk } from "rollup";
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

function emittedText(output: OutputAsset | OutputChunk): string {
  if (output.type === "chunk") return output.code;
  return typeof output.source === "string" ? output.source : Buffer.from(output.source).toString("utf8");
}

export function loopbackBuildGuardPlugin(): Plugin {
  return {
    name: "odos-loopback-build-guard",
    apply: "build",
    writeBundle(_options, bundle) {
      const findings: string[] = [];

      for (const output of Object.values(bundle)) {
        const urls = [...new Set((emittedText(output).match(ABSOLUTE_HTTP_URL) || []).filter(isLoopbackUrl))];
        for (const url of urls) findings.push(`${output.fileName}: ${url}`);
      }

      if (findings.length > 0) {
        throw new Error(`Production build contains viewer-local loopback URLs:\n${findings.join("\n")}`);
      }
    },
  };
}
