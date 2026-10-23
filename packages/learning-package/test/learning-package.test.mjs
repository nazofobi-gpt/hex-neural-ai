import assert from "node:assert/strict";
import test from "node:test";
import { intakeLearningPackage, sha256Hex } from "../dist/index.js";

const bytes = "licensed fixture";
const base = async () => ({
  schemaVersion: "1",
  sourceId: "fixture",
  sourceVersion: "v1",
  uri: "fixture://licensed",
  usageRights: { verified: true, basis: "test fixture" },
  checksum: { algorithm: "sha256", value: await sha256Hex(bytes) },
  scope: ["knowledge"],
  lineage: ["fixture-root"]
});

test("verified source is accepted with lineage and checksum", async () => {
  const manifest = await base();
  const result = await intakeLearningPackage(manifest, { fact: 1 }, bytes);
  assert.equal(result.accepted, true);
  assert.equal(result.package.status, "VERIFIED");
  assert.deepEqual(result.package.manifest.lineage, ["fixture-root"]);
});

test("unverified usage rights fail closed", async () => {
  const manifest = await base();
  manifest.usageRights = { verified: false, basis: "" };
  const result = await intakeLearningPackage(manifest, {}, bytes);
  assert.equal(result.accepted, false);
  assert.equal(result.package.status, "BLOCKED_SOURCE");
  assert.equal(result.package.quarantineReason, "USAGE_RIGHTS_UNVERIFIED");
});

test("checksum mismatch is quarantined", async () => {
  const manifest = await base();
  const result = await intakeLearningPackage(manifest, {}, "tampered");
  assert.equal(result.accepted, false);
  assert.equal(result.package.status, "QUARANTINED");
  assert.equal(result.package.quarantineReason, "CHECKSUM_MISMATCH");
});

test("empty scope is quarantined", async () => {
  const manifest = await base();
  manifest.scope = [];
  const result = await intakeLearningPackage(manifest, {}, bytes);
  assert.equal(result.accepted, false);
  assert.equal(result.package.quarantineReason, "EMPTY_SCOPE");
});
