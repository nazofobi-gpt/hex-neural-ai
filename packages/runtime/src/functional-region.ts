export type RegionKind = "sensory" | "action" | "association" | "executive" | "memory";

export interface RegionPort {
  id: string;
  direction: "input" | "output";
  schema: string;
}

export interface FunctionalRegion {
  id: string;
  version: string;
  kind: RegionKind;
  semanticCentroid: readonly string[];
  ports: readonly RegionPort[];
  childRegionIds: readonly string[];
  coordinatorId?: string;
}

export interface RegionProjection {
  fromRegionId: string;
  toRegionId: string;
  schema: string;
  explicit: boolean;
}

export interface RegionTopology {
  version: string;
  regions: readonly FunctionalRegion[];
  projections: readonly RegionProjection[];
}

export interface RegionRoute {
  regionIds: readonly string[];
  fallbackUsed: boolean;
}

export type RegionRouteResult =
  | { ok: true; route: RegionRoute }
  | { ok: false; code: "REGION_NOT_FOUND" | "NO_EXPLICIT_ROUTE" | "ACTION_COORDINATOR_REQUIRED" };

function byId(topology: RegionTopology): Map<string, FunctionalRegion> {
  return new Map(topology.regions.map(region => [region.id, region]));
}

function neighbors(topology: RegionTopology, regionId: string, schema: string): string[] {
  return topology.projections
    .filter(p => p.explicit && p.fromRegionId === regionId && p.schema === schema)
    .map(p => p.toRegionId)
    .sort();
}

export function validateRegionTopology(topology: RegionTopology): readonly string[] {
  const errors: string[] = [];
  const regions = byId(topology);
  if (!topology.version.trim()) errors.push("MISSING_TOPOLOGY_VERSION");
  if (regions.size !== topology.regions.length) errors.push("DUPLICATE_REGION_ID");

  for (const region of topology.regions) {
    if (!region.version.trim()) errors.push(`MISSING_REGION_VERSION:${region.id}`);
    if (region.semanticCentroid.length === 0) errors.push(`EMPTY_SEMANTIC_CENTROID:${region.id}`);
    for (const childId of region.childRegionIds) {
      if (!regions.has(childId)) errors.push(`UNKNOWN_CHILD:${region.id}->${childId}`);
    }
    if (region.kind === "action" && !region.coordinatorId) {
      errors.push(`ACTION_COORDINATOR_REQUIRED:${region.id}`);
    }
  }

  for (const projection of topology.projections) {
    if (!projection.explicit) errors.push(`IMPLICIT_PROJECTION:${projection.fromRegionId}->${projection.toRegionId}`);
    if (!regions.has(projection.fromRegionId) || !regions.has(projection.toRegionId)) {
      errors.push(`UNKNOWN_PROJECTION_ENDPOINT:${projection.fromRegionId}->${projection.toRegionId}`);
    }
  }
  return errors.sort();
}

export function routeRegionLocalFirst(
  topology: RegionTopology,
  sourceRegionId: string,
  targetRegionId: string,
  schema: string,
): RegionRouteResult {
  const regions = byId(topology);
  const source = regions.get(sourceRegionId);
  const target = regions.get(targetRegionId);
  if (!source || !target) return { ok: false, code: "REGION_NOT_FOUND" };
  if (target.kind === "action" && !target.coordinatorId) {
    return { ok: false, code: "ACTION_COORDINATOR_REQUIRED" };
  }
  if (sourceRegionId === targetRegionId) {
    return { ok: true, route: { regionIds: [sourceRegionId], fallbackUsed: false } };
  }

  const queue: string[][] = [[sourceRegionId]];
  const visited = new Set([sourceRegionId]);
  while (queue.length) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    for (const next of neighbors(topology, current, schema)) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === targetRegionId) {
        return { ok: true, route: { regionIds: nextPath, fallbackUsed: false } };
      }
      visited.add(next);
      queue.push(nextPath);
    }
  }

  return { ok: false, code: "NO_EXPLICIT_ROUTE" };
}

export function flatDeterministicFallback(
  topology: RegionTopology,
  sourceRegionId: string,
  targetRegionId: string,
): RegionRouteResult {
  const regions = byId(topology);
  if (!regions.has(sourceRegionId) || !regions.has(targetRegionId)) {
    return { ok: false, code: "REGION_NOT_FOUND" };
  }
  const target = regions.get(targetRegionId)!;
  if (target.kind === "action" && !target.coordinatorId) {
    return { ok: false, code: "ACTION_COORDINATOR_REQUIRED" };
  }
  return { ok: true, route: { regionIds: [sourceRegionId, targetRegionId], fallbackUsed: true } };
}
