import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* streamTextLines(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    yield line;
  }
}
