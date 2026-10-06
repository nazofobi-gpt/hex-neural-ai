import test from "node:test";
import assert from "node:assert/strict";
import {
  flatDeterministicFallback,
  routeRegionLocalFirst,
  validateRegionTopology,
} from "../dist/index.js";

function region(id, kind, coordinatorId) {
  return {
    id,
    version: "1",
    kind,
    semanticCentroid: [id],
    ports: [],
    childRegionIds: [],
    ...(coordinatorId ? { coordinatorId } : {}),
  };
}

const topology = {
  version: "1",
  regions: [
    region("sensory", "sensory"),
    region("association", "association"),
    region("executive", "executive"),
    region("action", "action", "executive"),
    region("memory", "memory"),
  ],
  projections: [
    { fromRegionId: "sensory", toRegionId: "association", schema: "application/json", explicit: true },
    { fromRegionId: "association", toRegionId: "executive", schema: "application/json", explicit: true },
    { fromRegionId: "executive", toRegionId: "action", schema: "application/json", explicit: true },
    { fromRegionId: "association", toRegionId: "memory", schema: "application/json", explicit: true },
  ],
};

test("functional regions validate and route local-first through explicit bridges", () => {
  assert.deepEqual(validateRegionTopology(topology), []);
  const route = routeRegionLocalFirst(topology, "sensory", "action", "application/json");
  assert.equal(route.ok, true);
  assert.deepEqual(route.route.regionIds, ["sensory", "association", "executive", "action"]);
  assert.equal(route.route.fallbackUsed, false);
});

test("cross-modal full mesh is absent and unsupported schema fails closed", () => {
  const route = routeRegionLocalFirst(topology, "sensory", "memory", "text/plain");
  assert.deepEqual(route, { ok: false, code: "NO_EXPLICIT_ROUTE" });
});

test("action regions require a coordinator", () => {
  const unsafe = {
    ...topology,
    regions: topology.regions.map(r => r.id === "action" ? { ...r, coordinatorId: undefined } : r),
  };
  assert.ok(validateRegionTopology(unsafe).includes("ACTION_COORDINATOR_REQUIRED:action"));
  assert.deepEqual(
    routeRegionLocalFirst(unsafe, "executive", "action", "application/json"),
    { ok: false, code: "ACTION_COORDINATOR_REQUIRED" },
  );
});

test("flat deterministic fallback is explicit and marked", () => {
  const route = flatDeterministicFallback(topology, "sensory", "memory");
  assert.equal(route.ok, true);
  assert.deepEqual(route.route.regionIds, ["sensory", "memory"]);
  assert.equal(route.route.fallbackUsed, true);
});
