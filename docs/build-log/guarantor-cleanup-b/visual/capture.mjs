import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "../../../../ui/node_modules/playwright-core/index.mjs";

const directory = "docs/build-log/guarantor-cleanup-b/visual";
const beforeRoot = "../guarantor-cleanup-b-visual-before";
const base = "0255cc5ba1d8e097ee5b129c3219e7030fd49802";
const source = "8286affbe8ca26668b50119f137459669cf3286c";
const productionPaths = ["ui/src/components/comms/EngageSheet.tsx", "ui/src/lib/communications-client.ts"];
const notice = "The chart contact was not updated. Update the guarantor record: Synthetic Guarantor (Person/D).";
const ports = { before: 15140, after: 15141 };
const fixturePath = "/tests/fixtures/guarantor-notice.html";
const purposes = ["recalls", "appointment", "product-pickup", "marketing-promo", "education"];
const channels = ["sms", "call", "email", "mail"];
const preferenceRows = purposes.flatMap(purpose => channels.map(channel => ({
  purpose, channel, value: true, source: "default", evidenceSummary: [], lastSet: null, evidenceStatus: "not-required",
})));
const preferenceMatrix = Object.fromEntries(purposes.map(purpose => [purpose, Object.fromEntries(channels.map(channel => [channel, { value: true, source: "default" }]))]));
const catalog = {
  items: [{
    id: "synthetic-home-care", version: 1, title: "Home care guide", kind: "handout", audience: "patient",
    dxCodes: [], channels: ["sms", "print"], laneHint: "clinical", consentClass: "transactional",
    urls: { web: "https://education.invalid/synthetic-home-care", print: "https://education.invalid/synthetic-home-care/print" },
  }],
  chartDispatchLane: "staff_switchable",
  availableChannels: { clinicalSms: true, frontdeskSms: false, email: false, print: true },
};
const optOut = {
  patientReference: "Patient/synthetic-child", smsOptedOut: false,
  remainingOptOuts: { global: false, numbers: [] },
  smsLanes: [{ label: "Clinical texts", number: "+15555550100", roles: ["clinical-sms"] }],
};

await mkdir(directory, { recursive: true });
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: beforeRoot, encoding: "utf8" }).trim(), base);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), base);
assert.equal(execFileSync("git", ["diff", "--", ...productionPaths], { cwd: beforeRoot, encoding: "utf8" }), "");
assert.equal(
  execFileSync("git", ["diff", "--", ...productionPaths], { encoding: "utf8" }),
  execFileSync("git", ["diff", base, source, "--", ...productionPaths], { encoding: "utf8" }),
  "The after worktree must contain exactly the committed UI production diff",
);
for (const root of [beforeRoot, "."]) {
  await copyFile(`${directory}/fixture.html`, `${root}/ui/tests/fixtures/guarantor-notice.html`);
  await copyFile(`${directory}/fixture.tsx`, `${root}/ui/tests/fixtures/guarantor-notice.tsx`);
}
const browser = await chromium.launch(process.env.CHROME_EXECUTABLE
  ? { executablePath: process.env.CHROME_EXECUTABLE }
  : { channel: "chrome" });
const records = [];
try {
  for (const scenario of ["sms", "print"]) {
    for (const state of ["before", "after"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const dispatches = [];
      const pageErrors = [];
      try {
        const page = await context.newPage();
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.route("**/communications/**", async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          let body;
          if (path === "/communications/education/dispatch" && request.method() === "POST") {
            const input = request.postDataJSON();
            dispatches.push(input);
            assert.equal(input.channel, scenario);
            assert.equal(input.patientReference, "Patient/synthetic-child");
            if (scenario === "sms") assert.equal(input.recipientOverride?.reference, "RelatedPerson/synthetic-guarantor");
            else assert.equal(input.recipientOverride, undefined);
            assert.equal(input.alsoUpdateChart, scenario === "sms");
            body = scenario === "sms"
              ? { outcome: "sent", providerMessageId: "synthetic-receipt", chartUpdateNotice: notice }
              : { outcome: "print", url: "https://education.invalid/synthetic-home-care/print", chartUpdateNotice: notice };
          } else if (path === "/communications/education" && request.method() === "GET") body = catalog;
          else if (path === "/communications/preferences" && request.method() === "GET") body = {
            patientReference: "Patient/synthetic-child", matrix: preferenceMatrix, rows: preferenceRows,
          };
          else if (path === "/communications/opt-out" && request.method() === "GET") body = optOut;
          else throw new Error(`Unexpected synthetic request: ${request.method()} ${path}`);
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        });
        const url = `http://127.0.0.1:${ports[state]}${fixturePath}`;
        await page.goto(url, { waitUntil: "networkidle" });
        const action = page.getByRole("button", { name: scenario === "sms" ? "Text Home care guide" : "Print Home care guide" });
        await action.waitFor({ state: "visible" });
        assert.equal(await action.isEnabled(), true, `${state} ${scenario} action disabled`);
        await action.click();
        if (scenario === "sms") {
          await page.getByRole("button", { name: "Override for this send" }).click();
          await page.getByRole("textbox", { name: "Recipient override" }).fill("+15555550199");
          await page.getByRole("checkbox", { name: "Also update chart" }).check();
        }
        await page.getByRole("button", { name: "Confirm education send" }).click();
        const ready = scenario === "sms" ? page.getByRole("status").filter({ hasText: "Education sent." }) : page.getByRole("link", { name: "Open print artifact" });
        await ready.waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(dispatches.length, 1);
        assert.deepEqual(pageErrors, []);
        const visibleStatus = (await page.getByRole("status").allTextContents()).join(" ");
        if (state === "before") assert.ok(!visibleStatus.includes(notice), `before ${scenario} showed notice`);
        else assert.ok(visibleStatus.includes(notice), `after ${scenario} did not show notice: ${visibleStatus}`);
        const screenshot = `${directory}/${scenario}-${state}.png`;
        await page.screenshot({ path: screenshot, animations: "disabled" });
        records.push({ scenario, state, url, visibleStatus, dispatch: dispatches[0], screenshot });
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(records[0].dispatch, records[1].dispatch);
assert.deepEqual(records[2].dispatch, records[3].dispatch);
const block = execFileSync(process.execPath, [
  ".claude/skills/before-and-after/scripts/format.mjs",
  "--before", `${directory}/sms-before.png`, "--after", `${directory}/sms-after.png`,
  "--before", `${directory}/print-before.png`, "--after", `${directory}/print-after.png`,
  "--label", "SMS send", "--label", "Print result",
], { encoding: "utf8" });
await writeFile(`${directory}/block.md`, block);
await writeFile(`${directory}/capture-results.json`, JSON.stringify(records, null, 2) + "\n");
console.log(`Captured ${records.length} synthetic states using the real EngageSheet and communications client.`);
for (const record of records) console.log(`${record.scenario} ${record.state}: ${record.visibleStatus || "(no status text)"}`);
