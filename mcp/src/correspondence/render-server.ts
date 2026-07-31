import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  ExecFileWeasyPrintRenderer,
  WEASYPRINT_VERSION,
} from "./weasyprint-renderer.js";

const PORT = 8788;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const renderer = new ExecFileWeasyPrintRenderer();
const execFileAsync = promisify(execFile);

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const { stdout } = await execFileAsync("weasyprint", ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (!stdout.includes(`WeasyPrint version ${WEASYPRINT_VERSION}`)) {
        throw new Error(`Expected WeasyPrint ${WEASYPRINT_VERSION}.`);
      }
      respond(response, 200, "text/plain; charset=utf-8", "ok");
      return;
    }
    if (request.method === "POST" && request.url === "/render") {
      const html = await readBody(request);
      const pdf = await renderer.render(html);
      respond(response, 200, "application/pdf", pdf);
      return;
    }
    respond(response, 404, "text/plain; charset=utf-8", "not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "render failure";
    respond(response, 503, "text/plain; charset=utf-8", message);
  }
}).listen(PORT, "0.0.0.0", () => {
  console.error(`odos-weasyprint: listening on ${PORT}`);
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_HTML_BYTES) throw new Error("HTML input exceeds 5 MB.");
    chunks.push(bytes);
  }
  const html = Buffer.concat(chunks).toString("utf8");
  if (!html.trim()) throw new Error("HTML input is required.");
  return html;
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}
