import { createHash } from "node:crypto";
import readline from "node:readline";
import {
  commitRegionMigration,
  flatDeterministicFallback,
  prepareRegionMigration,
  rollbackRegionMigration,
  routeRegionLocalFirst,
} from "../dist/index.js";

const processId = process.argv[2];
if (!processId) {
  throw new Error("PROCESS_ID_REQUIRED");
}

let snapshot = null;
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function reply(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(id, code, message = code) {
  reply({ id, ok: false, code, message });
}

function authoritative(id) {
  if (!snapshot || snapshot.ownerId !== processId) {
    fail(id, "PROCESS_NOT_AUTHORITATIVE");
    return false;
  }
  return true;
}

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ id: null, ok: false, code: "INVALID_JSON" });
    return;
  }

  const { id, command } = request;
  try {
    if (command === "install") {
      snapshot = structuredClone(request.snapshot);
      reply({
        id,
        ok: true,
        state: {
          processId,
          ownerId: snapshot.ownerId,
          ownerEpoch: snapshot.ownerEpoch,
          topologyVersion: snapshot.topology.version,
          shardCount: snapshot.shards.length,
        },
      });
      return;
    }

    if (command === "prepare") {
      if (!authoritative(id)) return;
      const result = prepareRegionMigration(snapshot, request.intent);
      reply({ id, ...result });
      return;
    }

    if (command === "commit") {
      if (!authoritative(id)) return;
      const result = commitRegionMigration(snapshot, request.prepared);
      if (result.ok) snapshot = structuredClone(result.value.after);
      reply({ id, ...result });
      return;
    }

    if (command === "rollback") {
      if (!authoritative(id)) return;
      const result = rollbackRegionMigration(
        snapshot,
        request.receipt,
        processId,
        snapshot.ownerEpoch,
      );
      if (result.ok) snapshot = structuredClone(result.value);
      reply({ id, ...result });
      return;
    }

    if (command === "snapshot") {
      reply({ id, ok: true, value: structuredClone(snapshot) });
      return;
    }

    if (command === "route") {
      const topology = request.topology ?? snapshot?.topology;
      if (!topology) {
        fail(id, "TOPOLOGY_REQUIRED");
        return;
      }
      const result = request.mode === "region"
        ? routeRegionLocalFirst(
            topology,
            request.sourceRegionId,
            request.targetRegionId,
            request.schema,
          )
        : flatDeterministicFallback(
            topology,
            request.sourceRegionId,
            request.targetRegionId,
          );
      reply({ id, ...result });
      return;
    }

    if (command === "deliver") {
      const payload = typeof request.payload === "string" ? request.payload : "";
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const sha256 = createHash("sha256").update(payload).digest("hex");
      reply({ id, ok: true, processId, payloadBytes, sha256 });
      return;
    }

    fail(id, "UNKNOWN_COMMAND");
  } catch (error) {
    fail(id, "WORKER_EXCEPTION", error instanceof Error ? error.message : String(error));
  }
});
