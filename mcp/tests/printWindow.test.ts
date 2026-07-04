import assert from "node:assert/strict";
import { test } from "node:test";
import { openPrintWindow } from "../../ui/src/lib/print-window.js";

test("openPrintWindow writes a complete printable document and triggers browser print on load", () => {
  const writes: string[] = [];
  let opened = false;
  let closed = false;
  const result = openPrintWindow("Receipt & <Summary>", "<section>Receipt body</section>", () => ({
    document: {
      open: () => {
        opened = true;
      },
      write: (html: string) => {
        writes.push(html);
      },
      close: () => {
        closed = true;
      },
    },
  }));

  assert.equal(result, true);
  assert.equal(opened, true);
  assert.equal(closed, true);
  const html = writes.join("");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Receipt &amp; &lt;Summary&gt;<\/title>/);
  assert.match(html, /<section>Receipt body<\/section>/);
  assert.match(html, /window\.print\(\)/);
  assert.doesNotMatch(html, /undefined/);
});

test("openPrintWindow reports a blocked popup without writing", () => {
  const result = openPrintWindow("Receipt", "<section>Receipt body</section>", () => null);
  assert.equal(result, false);
});
