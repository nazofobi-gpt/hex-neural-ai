import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const workerPath = fileURLToPath(new URL("./region-process-worker.mjs", import.meta.url));

class RegionProcess {
  #sequence = 0;
  #pending = new Map();
  #buffer = "";

  constructor(id) {
    this.id = id;
    this.child = spawn(process.execPath, [workerPath, id], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        pending.resolve({
          response,
          requestBytes: pending.requestBytes,
          responseBytes: Buffer.byteLength(line + "\n", "utf8"),
          elapsedMs: performance.now() - pending.startedAt,
        });
      }
    });
    this.child.on("exit", code => {
      if (code === 0) return;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`region process ${id} exited with ${code}`));
      }
      this.#pending.clear();
    });
  }

  request(body) {
    const id = `${this.id}-${++this.#sequence}`;
    const wire = JSON.stringify({ id, ...body }) + "\n";
    const requestBytes = Buffer.byteLength(wire, "utf8");
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, requestBytes, startedAt });
      this.child.stdin.write(wire, "utf8", error => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    await exited;
  }
}

const region = id => ({
  id,
  version: "1",
  kind: "association",
  semanticCentroid: [id],
  ports: [],
  childRegionIds: [],
});

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
}

test("separate owner processes hand off, fence stale owners, migrate replicas and rollback", async t => {
  const owner1 = new RegionProcess("worker-1");
  const owner2 = new RegionProcess("worker-2");
  const owner3 = new RegionProcess("worker-3");
  const owners = [owner1, owner2, owner3];
  t.after(async () => {
    await Promise.all(owners.map(owner => owner.close()));
  });

  assert.equal(new Set(owners.map(owner => owner.child.pid)).size, 3);

  const base = {
    topology: {
      version: "1",
      regions: [region("a"), region("b")],
      projections: [],
    },
    ownerId: "worker-1",
    ownerEpoch: 4,
    shards: [
      {
        shardId: "one",
        regionId: "a",
        stateVersion: 3,
        stateRef: "sha256:one",
      },
      {
        shardId: "two",
        regionId: "b",
        stateVersion: 8,
        stateRef: "sha256:two",
      },
    ],
  };

  const observations = [];
  observations.push(await owner1.request({ command: "install", snapshot: base }));

  const splitIntent = {
    checkpointId: "process-checkpoint-1",
    expectedOwnerId: "worker-1",
    expectedOwnerEpoch: 4,
    nextOwnerId: "worker-2",
    nextTopology: {
      version: "2",
      regions: [region("a"), region("b"), region("c")],
      projections: [],
    },
    placements: [
      {
        shardId: "one",
        regionId: "c",
        replicaOwnerIds: ["worker-3"],
      },
      {
        shardId: "two",
        regionId: "b",
        replicaOwnerIds: ["worker-3"],
      },
    ],
  };

  const prepared1 = await owner1.request({
    command: "prepare",
    intent: splitIntent,
  });
  observations.push(prepared1);
  assert.equal(prepared1.response.ok, true);

  const committed1 = await owner1.request({
    command: "commit",
    prepared: prepared1.response.value,
  });
  observations.push(committed1);
  assert.equal(committed1.response.ok, true);
  assert.equal(committed1.response.value.after.ownerId, "worker-2");
  assert.equal(committed1.response.value.after.ownerEpoch, 5);

  const install2 = await owner2.request({
    command: "install",
    snapshot: committed1.response.value.after,
  });
  observations.push(install2);
  assert.equal(install2.response.state.ownerId, "worker-2");

  const stale1 = await owner1.request({
    command: "prepare",
    intent: {
      ...splitIntent,
      checkpointId: "stale-owner-1",
      expectedOwnerId: "worker-2",
      expectedOwnerEpoch: 5,
      nextOwnerId: "worker-3",
      nextTopology: {
        ...splitIntent.nextTopology,
        version: "stale",
      },
    },
  });
  observations.push(stale1);
  assert.equal(stale1.response.ok, false);
  assert.equal(stale1.response.code, "PROCESS_NOT_AUTHORITATIVE");

  const mergeIntent = {
    checkpointId: "process-checkpoint-2",
    expectedOwnerId: "worker-2",
    expectedOwnerEpoch: 5,
    nextOwnerId: "worker-3",
    nextTopology: {
      version: "3",
      regions: [region("b"), region("c")],
      projections: [],
    },
    placements: [
      {
        shardId: "one",
        regionId: "c",
        replicaOwnerIds: ["worker-1"],
      },
      {
        shardId: "two",
        regionId: "b",
        replicaOwnerIds: ["worker-1"],
      },
    ],
  };

  const prepared2 = await owner2.request({
    command: "prepare",
    intent: mergeIntent,
  });
  observations.push(prepared2);
  assert.equal(prepared2.response.ok, true);

  const committed2 = await owner2.request({
    command: "commit",
    prepared: prepared2.response.value,
  });
  observations.push(committed2);
  assert.equal(committed2.response.ok, true);
  assert.equal(committed2.response.value.after.ownerId, "worker-3");
  assert.equal(committed2.response.value.after.ownerEpoch, 6);

  const install3 = await owner3.request({
    command: "install",
    snapshot: committed2.response.value.after,
  });
  observations.push(install3);
  assert.equal(install3.response.state.ownerId, "worker-3");

  const stale2 = await owner2.request({
    command: "prepare",
    intent: {
      ...mergeIntent,
      checkpointId: "stale-owner-2",
      expectedOwnerId: "worker-3",
      expectedOwnerEpoch: 6,
      nextOwnerId: "worker-1",
      nextTopology: {
        ...mergeIntent.nextTopology,
        version: "4",
      },
    },
  });
  observations.push(stale2);
  assert.equal(stale2.response.ok, false);
  assert.equal(stale2.response.code, "PROCESS_NOT_AUTHORITATIVE");

  const rollback = await owner3.request({
    command: "rollback",
    receipt: committed2.response.value,
  });
  observations.push(rollback);
  assert.equal(rollback.response.ok, true);
  assert.equal(rollback.response.value.topology.version, "2");
  assert.equal(rollback.response.value.ownerId, "worker-3");
  assert.equal(rollback.response.value.ownerEpoch, 7);
  assert.deepEqual(
    rollback.response.value.shards.map(shard => [
      shard.shardId,
      shard.stateVersion,
      shard.stateRef,
    ]),
    [
      ["one", 3, "sha256:one"],
      ["two", 8, "sha256:two"],
    ],
  );

  console.log("G226_PROCESS_MIGRATION", JSON.stringify({
    processIds: owners.map(owner => owner.child.pid),
    ownerEpochs: [4, 5, 6, 7],
    transportBytes: observations.reduce(
      (sum, item) => sum + item.requestBytes + item.responseBytes,
      0,
    ),
    p95RoundTripMs: p95(observations.map(item => item.elapsedMs)),
    rollbackTopologyVersion: rollback.response.value.topology.version,
  }));
});

test("matched region and flat workloads measure actual child-process IPC bytes and end-to-end p95", async t => {
  const workers = {
    a: new RegionProcess("region-a"),
    b: new RegionProcess("region-b"),
    c: new RegionProcess("region-c"),
  };
  t.after(async () => {
    await Promise.all(Object.values(workers).map(worker => worker.close()));
  });

  const topology = {
    version: "process-bench-1",
    regions: [region("a"), region("b"), region("c")],
    projections: [
      {
        fromRegionId: "a",
        toRegionId: "b",
        schema: "application/json",
        explicit: true,
      },
      {
        fromRegionId: "a",
        toRegionId: "c",
        schema: "application/json",
        explicit: true,
      },
      {
        fromRegionId: "b",
        toRegionId: "c",
        schema: "application/json",
        explicit: true,
      },
    ],
  };
  const workload = [
    ["local-a-1", "a", "a", 512],
    ["local-b-1", "b", "b", 1024],
    ["a-b-1", "a", "b", 2048],
    ["a-c-1", "a", "c", 4096],
    ["b-c-1", "b", "c", 1536],
    ["local-c-1", "c", "c", 768],
  ].map(([sampleId, sourceRegionId, targetRegionId, payloadBytes]) => ({
    sampleId,
    sourceRegionId,
    targetRegionId,
    schema: "application/json",
    payloadBytes,
    payload: "x".repeat(payloadBytes),
  }));

  const provenance = {
    datasetId: "g226-process-ipc-workload-v1",
    source: "packages/runtime/test/region-process-harness.test.mjs",
    repetitions: 25,
    capturedAt: new Date().toISOString(),
    transport: "node-child-process-stdin-stdout-jsonl",
    costModel: {
      fixedCostUnits: 1,
      perInterRegionHopCostUnits: 0.25,
      perIpcByteCostUnits: 0.00001,
    },
  };

  async function runMode(mode) {
    const latencies = [];
    let localHitCount = 0;
    let interRegionHops = 0;
    let routeControlBytes = 0;
    let actualPayloadIpcBytes = 0;
    let acknowledgedPayloadBytes = 0;
    let modeledCostUnits = 0;
    const load = new Map([["a", 0], ["b", 0], ["c", 0]]);

    for (const sample of workload) {
      for (let repetition = 0; repetition < provenance.repetitions; repetition += 1) {
        const started = performance.now();
        const routeCall = await workers[sample.sourceRegionId].request({
          command: "route",
          mode,
          topology,
          sourceRegionId: sample.sourceRegionId,
          targetRegionId: sample.targetRegionId,
          schema: sample.schema,
        });
        assert.equal(routeCall.response.ok, true);
        routeControlBytes += routeCall.requestBytes + routeCall.responseBytes;
        const route = routeCall.response.route.regionIds;
        if (route.length === 1) localHitCount += 1;
        interRegionHops += Math.max(0, route.length - 1);
        for (const regionId of route) {
          load.set(regionId, (load.get(regionId) ?? 0) + 1);
        }

        let operationIpcBytes = 0;
        for (let hop = 1; hop < route.length; hop += 1) {
          const targetRegion = route[hop];
          const delivery = await workers[targetRegion].request({
            command: "deliver",
            sampleId: sample.sampleId,
            payload: sample.payload,
          });
          assert.equal(delivery.response.ok, true);
          assert.equal(delivery.response.payloadBytes, sample.payloadBytes);
          const wireBytes = delivery.requestBytes + delivery.responseBytes;
          operationIpcBytes += wireBytes;
          actualPayloadIpcBytes += wireBytes;
          acknowledgedPayloadBytes += delivery.response.payloadBytes;
        }

        modeledCostUnits +=
          provenance.costModel.fixedCostUnits +
          provenance.costModel.perInterRegionHopCostUnits * Math.max(0, route.length - 1) +
          provenance.costModel.perIpcByteCostUnits * operationIpcBytes;
        latencies.push(performance.now() - started);
      }
    }

    const loads = [...load.values()];
    return {
      operationCount: workload.length * provenance.repetitions,
      localHitCount,
      interRegionHops,
      routeControlBytes,
      actualPayloadIpcBytes,
      acknowledgedPayloadBytes,
      p95EndToEndMs: p95(latencies),
      modeledCostUnits,
      maxRegionLoad: Math.max(...loads),
      minRegionLoad: Math.min(...loads),
    };
  }

  const regionMetrics = await runMode("region");
  const flatMetrics = await runMode("flat");

  assert.equal(regionMetrics.operationCount, flatMetrics.operationCount);
  assert.ok(regionMetrics.localHitCount > 0);
  assert.equal(flatMetrics.localHitCount, 0);
  assert.ok(Number.isFinite(regionMetrics.p95EndToEndMs));
  assert.ok(Number.isFinite(flatMetrics.p95EndToEndMs));
  assert.ok(regionMetrics.actualPayloadIpcBytes >= 0);
  assert.ok(flatMetrics.actualPayloadIpcBytes >= 0);

  console.log("G226_PROCESS_BENCHMARK", JSON.stringify({
    provenance,
    region: regionMetrics,
    flat: flatMetrics,
  }));
});
