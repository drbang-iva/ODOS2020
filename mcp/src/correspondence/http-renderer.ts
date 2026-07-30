import {
  PDF_A_3U_VARIANT,
  WEASYPRINT_VERSION,
  type CorrespondenceRenderer,
} from "./weasyprint-renderer.js";

export class WeasyPrintHttpRenderer implements CorrespondenceRenderer {
  readonly name = `WeasyPrint ${WEASYPRINT_VERSION}`;
  readonly pdfVariant = PDF_A_3U_VARIANT;

  constructor(
    private readonly baseUrl =
      process.env.ODOS_WEASYPRINT_URL ?? "http://weasyprint:8788",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async render(html: string): Promise<Buffer> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/render`, {
      method: "POST",
      headers: {
        Accept: "application/pdf",
        "Content-Type": "text/html; charset=utf-8",
      },
      body: html,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `WeasyPrint sidecar failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
      );
    }
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 5).toString() !== "%PDF-") {
      throw new Error("WeasyPrint sidecar returned a non-PDF response.");
    }
    return pdf;
  }
}
