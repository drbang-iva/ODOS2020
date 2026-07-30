import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecFileException, ExecFileOptions } from "node:child_process";
import {
  ExecFileWeasyPrintRenderer,
  PDF_A_3U_VARIANT,
} from "../src/correspondence/weasyprint-renderer.js";

test("WeasyPrint renderer streams HTML stdin to PDF stdout with the verified PDF/A-3u CLI contract", async () => {
  const calls: Array<{
    file: string;
    args: readonly string[];
    options: ExecFileOptions;
    input?: string;
  }> = [];
  const renderer = new ExecFileWeasyPrintRenderer((file, args, options, callback) => {
    const child = {
      stdin: {
        end(input: string) {
          calls[0]!.input = input;
          callback(null, Buffer.from("%PDF-1.7 synthetic"), Buffer.alloc(0));
        },
      },
    };
    calls.push({ file, args, options });
    return child;
  });

  const pdf = await renderer.render("<!doctype html><html><body>Letter</body></html>");

  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(calls[0]?.args, ["--pdf-variant", PDF_A_3U_VARIANT, "-", "-"]);
  assert.equal(calls[0]?.options.encoding, "buffer");
  assert.equal(calls[0]?.options.timeout, 15_000);
  assert.match(calls[0]?.input ?? "", /Letter/);
  assert.equal(renderer.name, "WeasyPrint 69.0");
  assert.equal(renderer.pdfVariant, "pdf/a-3u");
});

test("WeasyPrint renderer fails loudly on subprocess errors and non-PDF output", async () => {
  const failing = new ExecFileWeasyPrintRenderer((_file, _args, _options, callback) => {
    const child = { stdin: { end() {
      const error = new Error("spawn weasyprint ENOENT") as ExecFileException;
      callback(error, Buffer.alloc(0), Buffer.from("missing renderer"));
    } } };
    return child;
  });
  await assert.rejects(failing.render("<p>test</p>"), /missing renderer/);

  const invalid = new ExecFileWeasyPrintRenderer((_file, _args, _options, callback) => {
    const child = { stdin: { end() {
      callback(null, Buffer.from("not a pdf"), Buffer.alloc(0));
    } } };
    return child;
  });
  await assert.rejects(invalid.render("<p>test</p>"), /valid PDF/);
});
