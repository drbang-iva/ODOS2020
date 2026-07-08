import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACT_BLOCK_HEIGHT,
  isCompactBlock,
} from "../../ui/src/lib/scheduler-block-density.js";

test("blocks shorter than the threshold are compact", () => {
  // 15-min slot at zoom 1: 1 row × 46px − 6 = 40px → compact
  assert.equal(isCompactBlock(40), true);
  // 30-min at zoom 1: 2 × 46 − 6 = 86px → full content
  assert.equal(isCompactBlock(86), false);
  // 15-min at zoom 1.75: round(46 × 1.75) − 6 = 75px → zooming in restores full content
  assert.equal(isCompactBlock(75), false);
  assert.equal(isCompactBlock(COMPACT_BLOCK_HEIGHT), false, "threshold itself renders full");
  assert.equal(isCompactBlock(COMPACT_BLOCK_HEIGHT - 1), true);
});
