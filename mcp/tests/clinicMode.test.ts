import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLINIC_MODES,
  OSOD_DISCIPLINE_SYSTEM,
  SCHEDULING_DISCIPLINES,
  assertClinicMode,
  assertDiscipline,
  disciplineCoding,
  disciplinesForMode,
  isDisciplineVisible,
} from "../src/scheduling/clinic-mode.js";

test("the clinic-mode vocabulary is eyecare / aesthetics / both (design brief §1)", () => {
  const codes = CLINIC_MODES.map((m) => m.code);
  assert.deepEqual(codes, ["eyecare", "aesthetics", "both"]);
});

test("the discipline vocabulary is the two schedulable disciplines", () => {
  const codes = SCHEDULING_DISCIPLINES.map((d) => d.code);
  assert.deepEqual(codes, ["eyecare", "aesthetics"]);
});

test("assertClinicMode rejects a mode outside the three-mode vocabulary", () => {
  assert.throws(() => assertClinicMode("dental"), /clinic mode/i);
});

test("assertDiscipline rejects a code outside the discipline vocabulary", () => {
  assert.throws(() => assertDiscipline("both"), /discipline/i);
});

test("disciplinesForMode: a single-discipline practice sees only its own discipline", () => {
  assert.deepEqual(disciplinesForMode("eyecare"), ["eyecare"]);
  assert.deepEqual(disciplinesForMode("aesthetics"), ["aesthetics"]);
});

test("disciplinesForMode: combined mode sees both disciplines", () => {
  assert.deepEqual(disciplinesForMode("both"), ["eyecare", "aesthetics"]);
});

test("isDisciplineVisible filters the other discipline's noise out of a single-discipline practice", () => {
  assert.equal(isDisciplineVisible("eyecare", "eyecare"), true);
  assert.equal(isDisciplineVisible("aesthetics", "eyecare"), false);
  assert.equal(isDisciplineVisible("eyecare", "aesthetics"), false);
  assert.equal(isDisciplineVisible("aesthetics", "both"), true);
  assert.equal(isDisciplineVisible("eyecare", "both"), true);
});

test("disciplineCoding builds the osod discipline coding used to tag catalog entries and resources", () => {
  const coding = disciplineCoding("aesthetics");
  assert.equal(coding.system, OSOD_DISCIPLINE_SYSTEM);
  assert.equal(coding.code, "aesthetics");
  assert.equal(coding.display, "Aesthetics");
});
