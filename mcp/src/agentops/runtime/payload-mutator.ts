import { createHash } from "node:crypto";
import { SOURCE_SHA256_EXTENSION_URL } from "../types.js";

export interface AttachmentMutationResult<T> {
  readonly resource: T;
  readonly strippedAttachmentCount: number;
}

export function stripAttachmentDataForAgent<T>(
  resource: T,
  sourceUrlFor: (path: readonly string[]) => string,
): AttachmentMutationResult<T> {
  const counter = { count: 0 };
  const mutated = walk(resource, [], sourceUrlFor, counter);
  return {
    resource: mutated as T,
    strippedAttachmentCount: counter.count,
  };
}

function walk(
  value: unknown,
  path: readonly string[],
  sourceUrlFor: (path: readonly string[]) => string,
  counter: { count: number },
): unknown {
  if (Array.isArray(value)) {
    return value.map((child, index) => walk(child, [...path, String(index)], sourceUrlFor, counter));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value.data === "string" && looksLikeAttachment(value)) {
    counter.count += 1;
    const bytes = Buffer.from(value.data, "base64");
    const { data: _data, ...rest } = value;
    return {
      ...Object.fromEntries(
        Object.entries(rest).map(([key, child]) => [key, walk(child, [...path, key], sourceUrlFor, counter)]),
      ),
      hash: createHash("sha1").update(bytes).digest("base64"),
      url: typeof value.url === "string" && value.url ? value.url : sourceUrlFor(path),
      extension: [
        ...(Array.isArray(value.extension) ? value.extension : []),
        {
          url: SOURCE_SHA256_EXTENSION_URL,
          valueString: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, walk(child, [...path, key], sourceUrlFor, counter)]),
  );
}

function looksLikeAttachment(value: Record<string, unknown>): boolean {
  return (
    typeof value.data === "string" &&
    ("contentType" in value || "hash" in value || "title" in value || "url" in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
