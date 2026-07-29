export function binaryIdFromReferenceUrl(value: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(value, "https://odos.invalid").pathname;
  } catch {
    return undefined;
  }
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const binaryIndex = parts.lastIndexOf("Binary");
  if (binaryIndex < 0 || !parts[binaryIndex + 1]) return undefined;
  const suffix = parts.slice(binaryIndex + 2);
  if (
    suffix.length !== 0
    && !(suffix.length === 2 && suffix[0] === "_history" && Boolean(suffix[1]))
  ) {
    return undefined;
  }
  return parts[binaryIndex + 1];
}
