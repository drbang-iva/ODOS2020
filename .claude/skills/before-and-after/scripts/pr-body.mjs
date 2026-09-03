#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MARKER_START,
  MARKER_END,
  replaceMarkedBlock as upstreamReplaceMarkedBlock,
} from "./format.mjs";

export function replaceMarkedBlock(body, block) {
  const replacement = block.trim();
  if (!replacement.startsWith(MARKER_START) || !replacement.endsWith(MARKER_END)) {
    throw new Error("Replacement must be a complete before-and-after marker block");
  }
  // Reuse upstream validation, but not its whitespace-normalized output.
  upstreamReplaceMarkedBlock(replacement, "");
  upstreamReplaceMarkedBlock(body, replacement);
  const start = body.indexOf(MARKER_START);
  if (start === -1) {
    const separator = !body || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return body + separator + replacement + "\n";
  }
  const afterEnd = body.indexOf(MARKER_END) + MARKER_END.length;
  return body.slice(0, start) + replacement + body.slice(afterEnd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [bodyPath, blockPath, ...extra] = process.argv.slice(2);
    if (!bodyPath || !blockPath || extra.length) {
      throw new Error("Usage: node pr-body.mjs BODY_FILE BLOCK_FILE");
    }
    process.stdout.write(replaceMarkedBlock(readFileSync(bodyPath, "utf8"), readFileSync(blockPath, "utf8")));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
