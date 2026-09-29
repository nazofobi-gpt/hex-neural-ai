import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

const REPLICAS = [1, 2, 4, 8];
const TASKS = 240;
const ITERATIONS = 140000;
const PAYLOAD_BYTES = 4096;

function work(iterations) {
  let x = 0x9e3779b9;
  for (let i = 0; i < iterations; i++) {
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = (x + i) >>> 0;
  }
  return x;
}

if (!isMainThread) {
  for (const task of workerData.tasks) {
    const start = performance.now();
    work(task.iterations);
    parentPort.postMessage({ id: task.id, latencyMs: performance.now() - start });
  }
  parentPort.postMessage({ done: true });
} else {
  const results = [];
  for (const replicas of REPLICAS) {
    const tasks = Array.from({ length: TASKS }, (_, id) => ({ id, iterations: ITERATIONS }));
    const shards = Array.from({ length: replicas }, () => []);
    tasks.forEach((task, i) => shards[i % replicas].push(task));
    const latencies = [];
    const started = performance.now();
    await Promise.all(shards.map((shard) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { tasks: shard } });
      worker.on("message", (msg) => {
        if (msg.done) resolve();
        else latencies.push(msg.latencyMs);
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (code !== 0) reject(new Error("worker exit " + code)); });
    })));
    const elapsedSeconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    const p95LatencyMs = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
    results.push({
      replicas,
      tasks: TASKS,
      throughputPerSecond: TASKS / elapsedSeconds,
      p95LatencyMs,
      networkBytes: TASKS * PAYLOAD_BYTES * 2,
      replicaSeconds: replicas * elapsedSeconds,
      elapsedSeconds,
    });
  }
  const baseline = results[0].throughputPerSecond;
  for (const row of results) {
    row.scalingEfficiency = row.throughputPerSecond / baseline / row.replicas;
    row.normalizedCostPer1kTasks = row.replicaSeconds / row.tasks * 1000;
  }
  const useful = results.filter((r) => r.scalingEfficiency >= 0.70);
  const selected = useful.reduce((best, r) =>
    r.throughputPerSecond / r.replicaSeconds > best.throughputPerSecond / best.replicaSeconds ? r : best,
    useful[0] ?? results[0]);
  console.log("G209_BENCHMARK_JSON=" + JSON.stringify({
    workload: { tasks: TASKS, iterationsPerTask: ITERATIONS, payloadBytesPerTask: PAYLOAD_BYTES },
    matrix: results,
    minEfficiency: 0.70,
    selectedReplicas: selected.replicas,
    note: "Observed synthetic CPU/locality benchmark on this CI runner; replicaSeconds is a normalized compute-cost proxy, not cloud billing."
  }));
}
