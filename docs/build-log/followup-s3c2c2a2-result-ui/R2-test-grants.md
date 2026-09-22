## ui/tests/followUpQueue.test.tsx

Before:

```tsx
test("S3c2c2a1 G14 current Follow-up UI renders additive result fields unchanged", async () => {
  const baseline = { ...decisionPayload, rows: [
    { ...decisionPayload.rows[0] },
    { ...decisionPayload.rows[2] },
  ] };
  const augmented = { ...baseline, rows: [
    { ...baseline.rows[0], unreviewedResult: true },
    { ...baseline.rows[1], result: {
      status: "needs-interpretation", items: [{ mediaReference: "Media/photo-1", title: "synthetic.jpg", date: "2026-09-21T15:00:00Z" }], candidates: [],
    } },
  ] };
  const plain = await mounted(async () => Response.json(baseline));
  let expected: unknown;
  try { expected = text(plain.renderer.toJSON()); } finally { await plain.close(); }
  const linked = await mounted(async () => Response.json(augmented));
  try {
    assert.equal(text(linked.renderer.toJSON()), expected);
    assert.equal(linked.renderer.root.findAllByType("li").length, 2);
    assert.deepEqual(linked.renderer.root.findAllByType("li").map(row => row.findAllByType("button").map(button => button.children.join(""))), [["Not today"], []]);
  } finally { await linked.close(); }
});
```

After:

```tsx
test("S3c2c2a1 G14 read-only result facts render without mutation buttons (amended S3c2c2a2 R2)", async () => {
  const baseline = { ...decisionPayload, rows: [
    { ...decisionPayload.rows[0] },
    { ...decisionPayload.rows[2] },
  ] };
  const augmented = { ...baseline, rows: [
    { ...baseline.rows[0], unreviewedResult: true },
    { ...baseline.rows[1], result: {
      status: "needs-interpretation", items: [{ mediaReference: "Media/photo-1", title: "synthetic.jpg", date: "2026-09-21T15:00:00Z" }], candidates: [],
    } },
  ] };
  const plain = await mounted(async () => Response.json(baseline));
  let expected: unknown;
  try { expected = text(plain.renderer.toJSON()); } finally { await plain.close(); }
  const linked = await mounted(async () => Response.json(augmented));
  try {
    assert.doesNotMatch(String(expected), /Completed — needs interpretation|Done — not reviewed/);
    assert.match(text(linked.renderer.toJSON()), /Completed — needs interpretation/);
    assert.match(text(linked.renderer.toJSON()), /Done — not reviewed/);
    assert.equal(linked.renderer.root.findAllByType("input").length, 0);
    assert.equal(linked.renderer.root.findAllByType("li").length, 2);
    assert.deepEqual(linked.renderer.root.findAllByType("li").map(row => row.findAllByType("button").map(button => button.children.join(""))), [["Not today"], []]);
  } finally { await linked.close(); }
});
```

## mcp/tests/followUpResults.test.ts

Before:

```tsx
test("S3c2c2a1 G7 link refuses mismatched resources and maps store errors precisely", async () => {
  for (const media of [
    image("photo-1", "fundus-photo", "old"),
    image("photo-1", "oct"),
    image("photo-1", "fundus-photo", "e1", "ServiceRequest/other"),
    { ...image(), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const before = h.staff.writes.length;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, before);
  }
  for (const media of [
    image("photo-1", "fundus-photo", "old", "ServiceRequest/sr-2"),
    image("photo-1", "oct", "e1", "ServiceRequest/sr-2"),
    { ...image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "unlink");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [tests, ordered, target] of [
    [[optic], [], optic], [[gonio], [gonio], gonio],
  ] as const) {
    const h = await resultFixture([...tests], [...ordered]);
    h.staff.resources.push(image());
    const reply = await h.mutate(target.orderable, target.focus, "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [failure, expectedStatus, expectedCode] of [[412, 409, "concurrent-edit"], [undefined, 502, undefined]] as const) {
    const h = await resultFixture();
    h.staff.resources.push(image());
    if (failure) h.staff.failUpdateStatus = failure; else h.staff.failUpdateWithoutStatus = true;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, expectedStatus);
    assert.equal((reply.body as { code?: string }).code, expectedCode);
    assert.equal(h.staff.writes.length, 0);
  }
});
```

After:

```tsx
test("S3c2c2a1 G7 link refuses mismatched resources and maps store errors precisely", async () => {
  for (const media of [
    image("photo-1", "fundus-photo", "old"),
    image("photo-1", "oct"),
    image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-1"),
    { ...image(), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const before = h.staff.writes.length;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, before);
  }
  for (const media of [
    image("photo-1", "fundus-photo", "old", "ServiceRequest/sr-2"),
    image("photo-1", "oct", "e1", "ServiceRequest/sr-2"),
    { ...image("photo-1", "fundus-photo", "e1", "ServiceRequest/sr-2"), bodySite: { text: "retina" }, note: [{ text: "Procedure definition: synthetic" }] },
  ]) {
    const h = await resultFixture();
    h.staff.resources.push(media);
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "unlink");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [tests, ordered, target] of [
    [[optic], [], optic], [[gonio], [gonio], gonio],
  ] as const) {
    const h = await resultFixture([...tests], [...ordered]);
    h.staff.resources.push(image());
    const reply = await h.mutate(target.orderable, target.focus, "Media/photo-1", "link");
    assert.equal(reply.status, 409);
    assert.equal((reply.body as { code?: string }).code, "result-link-refused");
    assert.equal(h.staff.writes.length, 0);
  }
  for (const [failure, expectedStatus, expectedCode] of [[412, 409, "concurrent-edit"], [undefined, 502, undefined]] as const) {
    const h = await resultFixture();
    h.staff.resources.push(image());
    if (failure) h.staff.failUpdateStatus = failure; else h.staff.failUpdateWithoutStatus = true;
    const reply = await h.mutate("fundus-photography", "retina", "Media/photo-1", "link");
    assert.equal(reply.status, expectedStatus);
    assert.equal((reply.body as { code?: string }).code, expectedCode);
    assert.equal(h.staff.writes.length, 0);
  }
});
```
