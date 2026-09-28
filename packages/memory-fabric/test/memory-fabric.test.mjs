import test from "node:test";
import assert from "node:assert/strict";
import { MemoryFabric } from "../dist/index.js";

const source = {sourceId:"manual",version:"v1",checksum:"sha256:abc",scope:"project:hex",content:"Alpha routing provenance. Beta memory removal."};

test("preserves provenance and scope isolation", () => {
  const fabric = new MemoryFabric();
  const chunks = fabric.ingest(source, 24);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every(c => c.sourceId === "manual" && c.sourceVersion === "v1" && c.checksum === "sha256:abc"));
  assert.equal(fabric.recall("routing", ["global"]).length, 0);
  assert.equal(fabric.recall("routing", ["project:hex"])[0].chunk.sourceId, "manual");
});

test("deduplicates immutable source version", () => {
  const fabric = new MemoryFabric();
  const first = fabric.ingest(source, 24);
  const second = fabric.ingest({...source, content:"tampered"}, 24);
  assert.deepEqual(second.map(x => x.id), first.map(x => x.id));
});

test("remove and rebuild never resurrect removed source", () => {
  const fabric = new MemoryFabric();
  fabric.ingest(source, 24);
  assert.ok(fabric.recall("routing", ["project:hex"]).length > 0);
  assert.ok(fabric.removeSource("manual", "v1") > 0);
  fabric.rebuild();
  assert.equal(fabric.recall("routing", ["project:hex"]).length, 0);
});

test("rejects provenance-free source", () => {
  const fabric = new MemoryFabric();
  assert.throws(() => fabric.ingest({...source, checksum:""}), /INVALID_SOURCE_PROVENANCE/);
});
