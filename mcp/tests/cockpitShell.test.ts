import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COCKPIT_DOCK_ITEMS,
  badgeDisplay,
  dockItem,
  togglePanel,
  type CockpitPanelId,
} from "../../ui/src/lib/cockpit-shell.js";

test("dock items are in the design-doc order (launcher → fax)", () => {
  const ids = COCKPIT_DOCK_ITEMS.map((item) => item.id);
  assert.deepEqual(ids, [
    "launcher",
    "messages",
    "calls",
    "requests",
    "team-chat",
    "notifications",
    "fax",
  ] satisfies CockpitPanelId[]);
});

test("dockItem returns the item and throws on an unknown id", () => {
  assert.equal(dockItem("messages").label, "Messages");
  assert.throws(() => dockItem("nope" as CockpitPanelId), /unknown cockpit panel/);
});

test("togglePanel opens, switches, and closes — one panel at a time", () => {
  assert.equal(togglePanel(null, "messages"), "messages", "opens from nothing");
  assert.equal(togglePanel("messages", "calls"), "calls", "switches to another");
  assert.equal(togglePanel("messages", "messages"), null, "clicking the open one closes it");
});

test("badgeDisplay hides zero/negative and caps at 99+", () => {
  assert.equal(badgeDisplay(0), null);
  assert.equal(badgeDisplay(-3), null);
  assert.equal(badgeDisplay(Number.NaN), null);
  assert.equal(badgeDisplay(5), "5");
  assert.equal(badgeDisplay(3.9), "3");
  assert.equal(badgeDisplay(99), "99");
  assert.equal(badgeDisplay(100), "99+");
});
