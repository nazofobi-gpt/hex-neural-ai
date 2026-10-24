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

test("deduplicates only an identical immutable source version", () => {
  const fabric = new MemoryFabric();
  const first = fabric.ingest(source, 24);
  const second = fabric.ingest({...source}, 24);
  assert.deepEqual(second.map(x => x.id), first.map(x => x.id));
});

for (const [kind, incoming, chunkSize] of [
  ["content", {...source, content:"tampered"}, 24],
  ["checksum", {...source, checksum:"sha256:different"}, 24],
  ["scope", {...source, scope:"global"}, 24],
  ["chunkSize", {...source}, 12]
]) {
  test(`rejects conflicting source version: ${kind} without corrupting stored chunks`, () => {
    const fabric = new MemoryFabric();
    const before = fabric.ingest(source, 24);
    assert.throws(() => fabric.ingest(incoming, chunkSize), /SOURCE_VERSION_CONFLICT/);
    assert.deepEqual(fabric.ingest(source, 24).map(c => c.id), before.map(c => c.id));
    assert.ok(fabric.recall("routing", ["project:hex"]).length > 0);
  });
}

test("remove and rebuild never resurrect removed source", () => {
  const fabric = new MemoryFabric();
  fabric.ingest(source, 24);
  assert.ok(fabric.recall("routing", ["project:hex"]).length > 0);
  assert.ok(fabric.removeSource("manual", "v1") > 0);
  fabric.rebuild();
  assert.equal(fabric.recall("routing", ["project:hex"]).length, 0);
});

test("rebuild preserves custom chunk boundaries and deterministic ids", () => {
  const fabric = new MemoryFabric();
  const longSource = {...source, sourceId:"custom", content:"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda."};
  const before = fabric.ingest(longSource, 12).map(({id, text, ordinal}) => ({id, text, ordinal}));
  fabric.rebuild();
  const after = fabric.ingest(longSource, 12).map(({id, text, ordinal}) => ({id, text, ordinal}));
  assert.deepEqual(after, before);
});

test("source ids and versions containing at-signs remain collision-free", () => {
  const fabric = new MemoryFabric();
  const firstSource = {...source, sourceId:"kb@tenant", version:"v@1"};
  const secondSource = {...source, sourceId:"kb", version:"tenant@v@1", checksum:"sha256:def", content:"Gamma isolation proof."};
  const first = fabric.ingest(firstSource, 16);
  const second = fabric.ingest(secondSource, 16);
  assert.notDeepEqual(first.map(x => x.id), second.map(x => x.id));
  assert.deepEqual(fabric.ingest(firstSource, 16).map(x => x.id), first.map(x => x.id));
  assert.ok(fabric.removeSource(firstSource.sourceId, firstSource.version) > 0);
  assert.equal(fabric.recall("routing", ["project:hex"]).some(hit => hit.chunk.sourceId === firstSource.sourceId), false);
  assert.ok(fabric.recall("isolation", ["project:hex"]).some(hit => hit.chunk.sourceId === secondSource.sourceId));
});

test("rejects invalid chunk sizes", () => {
  const fabric = new MemoryFabric();
  assert.throws(() => fabric.ingest(source, 0), /INVALID_CHUNK_SIZE/);
});

test("rejects provenance-free source", () => {
  const fabric = new MemoryFabric();
  assert.throws(() => fabric.ingest({...source, checksum:""}), /INVALID_SOURCE_PROVENANCE/);
});

test("ingest and recall expose immutable chunks that cannot escalate scope or falsify provenance", () => {
  const fabric = new MemoryFabric();
  const [ingested] = fabric.ingest(source, 24);
  assert.ok(Object.isFrozen(ingested));
  assert.throws(() => { ingested.scope = "global"; }, TypeError);
  assert.throws(() => { ingested.checksum = "sha256:spoofed"; }, TypeError);

  const hit = fabric.recall("routing", ["project:hex"])[0];
  assert.ok(Object.isFrozen(hit.chunk));
  assert.throws(() => { hit.chunk.text = "forged"; }, TypeError);
  assert.equal(fabric.recall("routing", ["global"]).length, 0);
  assert.equal(fabric.recall("routing", ["project:hex"])[0].chunk.checksum, source.checksum);
  fabric.rebuild();
  assert.equal(fabric.recall("routing", ["global"]).length, 0);
});
