import { Readable } from "node:stream";
import type { Binary } from "@medplum/fhirtypes";
import { parserBinaryHeaders } from "../parsers/binarySecurityContext.js";

const BINARY_UPLOAD_TIMEOUT_MS = 60_000;

export interface BinaryUploadAuth {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetch?: typeof fetch;
}

export interface UploadBinaryInput {
  readonly bytes?: Uint8Array;
  readonly stream?: Readable;
  readonly contentType: string;
  readonly filename: string;
  readonly securityContext: string;
  readonly auth: BinaryUploadAuth;
}

export interface UploadedBinary {
  readonly binaryId: string;
  readonly url: string;
  readonly resource: Binary;
}

export async function uploadBinary(input: UploadBinaryInput): Promise<UploadedBinary> {
  if ((input.bytes === undefined) === (input.stream === undefined)) {
    throw new Error("Raw Binary upload requires exactly one of bytes or stream.");
  }
  if (!input.contentType.trim()) {
    throw new Error("Raw Binary upload requires contentType.");
  }
  if (!input.filename.trim()) {
    throw new Error("Raw Binary upload requires filename for the caller's Media.content.title.");
  }
  const securityHeaders = parserBinaryHeaders(input.securityContext);
  const fetchImpl = input.auth.fetch ?? fetch;
  const response = await fetchImpl(
    `${input.auth.baseUrl.replace(/\/$/, "")}/fhir/R4/Binary`,
    {
      method: "POST",
      headers: {
        Accept: "application/fhir+json",
        Authorization: `Bearer ${input.auth.accessToken}`,
        "Content-Type": input.contentType,
        ...securityHeaders,
      },
      body: input.bytes ?? input.stream,
      signal: AbortSignal.timeout(BINARY_UPLOAD_TIMEOUT_MS),
      ...(input.stream ? { duplex: "half" } : {}),
    } as RequestInit & { duplex?: "half" },
  );
  if (!response.ok) {
    throw await binaryUploadError(response);
  }
  const resource = (await response.json()) as Binary;
  if (resource.resourceType !== "Binary" || !resource.id) {
    throw new Error("Raw Binary upload returned no Binary id.");
  }
  return {
    binaryId: resource.id,
    url: `Binary/${resource.id}`,
    resource,
  };
}

async function binaryUploadError(response: Response): Promise<Error> {
  const detail = (await response.text()).slice(0, 2_000);
  const error = new Error(`Raw Binary upload failed: ${response.status} ${response.statusText}: ${detail}`);
  (error as Error & { status?: number }).status = response.status;
  return error;
}
