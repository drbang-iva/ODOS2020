import {
  execFile,
  type ChildProcess,
  type ExecFileOptionsWithBufferEncoding,
} from "node:child_process";

export const WEASYPRINT_VERSION = "69.0";
export const PDF_A_3U_VARIANT = "pdf/a-3u";

export interface CorrespondenceRenderer {
  readonly name: string;
  readonly pdfVariant: typeof PDF_A_3U_VARIANT;
  render(html: string): Promise<Buffer>;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: Buffer,
  stderr: Buffer,
) => void;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithBufferEncoding,
  callback: ExecFileCallback,
) => Pick<ChildProcess, "stdin">;

export class ExecFileWeasyPrintRenderer implements CorrespondenceRenderer {
  readonly name = `WeasyPrint ${WEASYPRINT_VERSION}`;
  readonly pdfVariant = PDF_A_3U_VARIANT;

  constructor(
    private readonly execFileImpl: ExecFileLike = execFile as unknown as ExecFileLike,
    private readonly executable = "weasyprint",
  ) {}

  render(html: string): Promise<Buffer> {
    if (!html.trim()) return Promise.reject(new Error("WeasyPrint requires HTML input."));
    return new Promise((resolve, reject) => {
      const child = this.execFileImpl(
        this.executable,
        ["--pdf-variant", PDF_A_3U_VARIANT, "-", "-"],
        {
          encoding: "buffer",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 15_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(
              `WeasyPrint render failed: ${stderr.toString().trim() || error.message}`,
            ));
            return;
          }
          if (stdout.subarray(0, 5).toString() !== "%PDF-") {
            reject(new Error("WeasyPrint did not return a valid PDF."));
            return;
          }
          resolve(stdout);
        },
      );
      if (!child.stdin) {
        reject(new Error("WeasyPrint stdin is unavailable."));
        return;
      }
      child.stdin.end(html);
    });
  }
}
