import { createHash } from "node:crypto";

export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkceS256(input: {
  readonly codeChallenge: string;
  readonly codeVerifier?: string;
}): "missing-verifier" | "mismatch" | "match" {
  if (!input.codeVerifier) {
    return "missing-verifier";
  }
  return pkceS256Challenge(input.codeVerifier) === input.codeChallenge ? "match" : "mismatch";
}

export function assertPkceS256AuthorizationRequest(input: {
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
}): void {
  if (!input.codeChallenge) {
    throw new Error("invalid_request: code_challenge is required");
  }
  if (input.codeChallengeMethod !== "S256") {
    throw new Error("invalid_request: code_challenge_method must be S256");
  }
}
