import assert from "node:assert/strict";
import { test } from "node:test";
import { OSOD_DISCIPLINE_SYSTEM } from "../src/scheduling/clinic-mode.js";
import {
  RESOURCE_KINDS,
  buildSchedulingResource,
  isResourceVisibleInMode,
  resourceDisciplines,
  resourceKind,
} from "../src/fhir/schedulingResource.js";

test("the resource-kind vocabulary is provider / room / equipment (brief §3.3 three parallel calendar types)", () => {
  assert.deepEqual(
    RESOURCE_KINDS.map((k) => k.code),
    ["provider", "room", "equipment"],
  );
});

test("a provider resource is a Schedule whose actor is the Practitioner", () => {
  const schedule = buildSchedulingResource({
    kind: "provider",
    actorReference: "Practitioner/bang-eric",
    actorDisplay: "Bang, Eric",
    disciplines: ["eyecare"],
  });
  assert.equal(schedule.resourceType, "Schedule");
  assert.equal(schedule.active, true);
  assert.equal(schedule.actor[0]?.reference, "Practitioner/bang-eric");
  assert.equal(schedule.actor[0]?.display, "Bang, Eric");
  const coding = schedule.serviceCategory?.[0]?.coding?.[0];
  assert.equal(coding?.system, OSOD_DISCIPLINE_SYSTEM);
  assert.equal(coding?.code, "eyecare");
});

test("a room is a Location actor; equipment is a Device actor", () => {
  const room = buildSchedulingResource({
    kind: "room",
    actorReference: "Location/treatment-room-1",
    disciplines: ["aesthetics"],
  });
  const laser = buildSchedulingResource({
    kind: "equipment",
    actorReference: "Device/ipl-laser",
    disciplines: ["aesthetics"],
  });
  assert.equal(room.actor[0]?.reference, "Location/treatment-room-1");
  assert.equal(laser.actor[0]?.reference, "Device/ipl-laser");
});

test("a resource can serve both disciplines — one Schedule, two serviceCategory codings", () => {
  const schedule = buildSchedulingResource({
    kind: "provider",
    actorReference: "Practitioner/bang-eric",
    disciplines: ["eyecare", "aesthetics"],
  });
  assert.deepEqual(resourceDisciplines(schedule), ["eyecare", "aesthetics"]);
});

test("resourceKind derives provider/room/equipment from the actor reference", () => {
  const room = buildSchedulingResource({
    kind: "room",
    actorReference: "Location/exam-1",
    disciplines: ["eyecare"],
  });
  assert.equal(resourceKind(room), "room");
});

test("clinic-mode visibility: an aesthetics-only resource is invisible to an eyecare-only practice", () => {
  const laser = buildSchedulingResource({
    kind: "equipment",
    actorReference: "Device/ipl-laser",
    disciplines: ["aesthetics"],
  });
  assert.equal(isResourceVisibleInMode(laser, "eyecare"), false);
  assert.equal(isResourceVisibleInMode(laser, "aesthetics"), true);
  assert.equal(isResourceVisibleInMode(laser, "both"), true);
});

test("clinic-mode visibility: a dual-discipline resource is visible in every mode", () => {
  const dual = buildSchedulingResource({
    kind: "provider",
    actorReference: "Practitioner/bang-eric",
    disciplines: ["eyecare", "aesthetics"],
  });
  assert.equal(isResourceVisibleInMode(dual, "eyecare"), true);
  assert.equal(isResourceVisibleInMode(dual, "aesthetics"), true);
  assert.equal(isResourceVisibleInMode(dual, "both"), true);
});

test("kind/actor mismatch throws — a room must be a Location, not a Practitioner", () => {
  assert.throws(
    () =>
      buildSchedulingResource({
        kind: "room",
        actorReference: "Practitioner/bang-eric",
        disciplines: ["eyecare"],
      }),
    /room .*Location/i,
  );
});

test("validation: unknown kind, missing disciplines, unknown discipline all throw", () => {
  assert.throws(
    () =>
      buildSchedulingResource({
        kind: "chair",
        actorReference: "Location/exam-1",
        disciplines: ["eyecare"],
      }),
    /resource kind/i,
  );
  assert.throws(
    () =>
      buildSchedulingResource({
        kind: "room",
        actorReference: "Location/exam-1",
        disciplines: [],
      }),
    /discipline/i,
  );
  assert.throws(
    () =>
      buildSchedulingResource({
        kind: "room",
        actorReference: "Location/exam-1",
        disciplines: ["dental"],
      }),
    /discipline/i,
  );
});

test("comment passes through to Schedule.comment", () => {
  const schedule = buildSchedulingResource({
    kind: "room",
    actorReference: "Location/exam-1",
    disciplines: ["eyecare"],
    comment: "Pretest room — no dilation appointments",
  });
  assert.equal(schedule.comment, "Pretest room — no dilation appointments");
});
