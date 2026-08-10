import type { OutputAsset, OutputChunk } from "rollup";
import type { Plugin } from "vite";

const LOOPBACK_URL = /https?:\/\/(?:localhost(?=[.:/?#]|$)|127(?:\.\d{1,3}){3}(?=[:/?#]|$)|\[::1\](?=[:/?#]|$))[^\s"'`<>\\)]*/gi;

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
        const urls = [...new Set(emittedText(output).match(LOOPBACK_URL) || [])];
        for (const url of urls) findings.push(`${output.fileName}: ${url}`);
      }

      if (findings.length > 0) {
        throw new Error(`Production build contains viewer-local loopback URLs:\n${findings.join("\n")}`);
      }
    },
  };
}
