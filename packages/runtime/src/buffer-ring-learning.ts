export type BufferRouteOutcome =
  | "SUCCESS"
  | "WRONG"
  | "MISINTERPRETED"
  | "UNRESOLVED"
  | "CONFUSION";

export type BufferOutcomePolarity = "POSITIVE" | "NEGATIVE";

export interface BufferRouteLearningPolicy {
  positiveStep: number;
  wrongPenalty: number;
  misinterpretPenalty: number;
  unresolvedPenalty: number;
  confusionPenalty: number;
  minSamples: number;
  quarantineSevereFailures: number;
  hysteresisMargin: number;
  explorationFloor: number;
  instabilityThreshold: number;
}

export interface BufferRouteLearningRecord {
  routeId: string;
  score: number;
  samples: number;
  successes: number;
  severeFailures: number;
  confusionCount: number;
  oscillationCount: number;
  lastPolarity: BufferOutcomePolarity | null;
  quarantined: boolean;
}

export interface BufferRingLearningState {
  version: number;
  routes: Readonly<Record<string, BufferRouteLearningRecord>>;
}

export interface BufferRouteSelection {
  mode: "NEUTRAL" | "SPECIALIZED" | "NO_ROUTE";
  routeId: string | null;
  score: number;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function scoreBound(value: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function validateBufferRouteLearningPolicy(
  policy: BufferRouteLearningPolicy,
): readonly string[] {
  const errors: string[] = [];
  for (const [name, value] of [
    ["positiveStep", policy.positiveStep],
    ["wrongPenalty", policy.wrongPenalty],
    ["misinterpretPenalty", policy.misinterpretPenalty],
    ["unresolvedPenalty", policy.unresolvedPenalty],
    ["confusionPenalty", policy.confusionPenalty],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`INVALID_${name.toUpperCase()}`);
    }
  }
  if (!positiveInteger(policy.minSamples)) errors.push("INVALID_MIN_SAMPLES");
  if (!positiveInteger(policy.quarantineSevereFailures)) {
    errors.push("INVALID_QUARANTINE_THRESHOLD");
  }
  if (!Number.isFinite(policy.hysteresisMargin) || policy.hysteresisMargin < 0 || policy.hysteresisMargin > 2) {
    errors.push("INVALID_HYSTERESIS_MARGIN");
  }
  if (!Number.isFinite(policy.explorationFloor) || policy.explorationFloor <= 0 || policy.explorationFloor > 1) {
    errors.push("INVALID_EXPLORATION_FLOOR");
  }
  if (!positiveInteger(policy.instabilityThreshold)) {
    errors.push("INVALID_INSTABILITY_THRESHOLD");
  }
  return errors.sort();
}

export function createBufferRingLearningState(
  routeIds: readonly string[],
): BufferRingLearningState {
  const normalized = routeIds.map(id => id.trim()).sort();
  if (
    normalized.length === 0 ||
    normalized.some(id => !id) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error("INVALID_BUFFER_ROUTE_SET");
  }
  return {
    version: 0,
    routes: Object.fromEntries(
      normalized.map(routeId => [
        routeId,
        {
          routeId,
          score: 0,
          samples: 0,
          successes: 0,
          severeFailures: 0,
          confusionCount: 0,
          oscillationCount: 0,
          lastPolarity: null,
          quarantined: false,
        } satisfies BufferRouteLearningRecord,
      ]),
    ),
  };
}

function outcomeEffect(
  outcome: BufferRouteOutcome,
  policy: BufferRouteLearningPolicy,
): {
  delta: number;
  polarity: BufferOutcomePolarity;
  severe: boolean;
  confusion: boolean;
} {
  switch (outcome) {
    case "SUCCESS":
      return { delta: policy.positiveStep, polarity: "POSITIVE", severe: false, confusion: false };
    case "WRONG":
      return { delta: -policy.wrongPenalty, polarity: "NEGATIVE", severe: true, confusion: false };
    case "MISINTERPRETED":
      return { delta: -policy.misinterpretPenalty, polarity: "NEGATIVE", severe: true, confusion: true };
    case "UNRESOLVED":
      return { delta: -policy.unresolvedPenalty, polarity: "NEGATIVE", severe: false, confusion: false };
    case "CONFUSION":
      return { delta: -policy.confusionPenalty, polarity: "NEGATIVE", severe: true, confusion: true };
  }
}

export function applyBufferRouteOutcome(
  current: BufferRingLearningState,
  traversedRouteIds: readonly string[],
  outcome: BufferRouteOutcome,
  policy: BufferRouteLearningPolicy,
): BufferRingLearningState {
  if (validateBufferRouteLearningPolicy(policy).length) {
    throw new Error("INVALID_BUFFER_ROUTE_POLICY");
  }
  const uniqueTraversed = [...new Set(traversedRouteIds)];
  if (uniqueTraversed.length === 0) throw new Error("NO_TRAVERSED_ROUTE");
  for (const routeId of uniqueTraversed) {
    if (!current.routes[routeId]) throw new Error(`UNKNOWN_BUFFER_ROUTE:${routeId}`);
  }

  const effect = outcomeEffect(outcome, policy);
  const routes = Object.fromEntries(
    Object.entries(current.routes).map(([routeId, route]) => {
      if (!uniqueTraversed.includes(routeId)) {
        return [routeId, { ...route }];
      }
      const samples = route.samples + 1;
      const severeFailures = route.severeFailures + (effect.severe ? 1 : 0);
      const oscillationCount =
        route.lastPolarity && route.lastPolarity !== effect.polarity
          ? route.oscillationCount + 1
          : route.oscillationCount;
      const quarantined =
        route.quarantined ||
        (samples >= policy.minSamples &&
          severeFailures >= policy.quarantineSevereFailures);

      return [
        routeId,
        {
          ...route,
          score: scoreBound(route.score + effect.delta),
          samples,
          successes: route.successes + (outcome === "SUCCESS" ? 1 : 0),
          severeFailures,
          confusionCount: route.confusionCount + (effect.confusion ? 1 : 0),
          oscillationCount,
          lastPolarity: effect.polarity,
          quarantined,
        },
      ];
    }),
  );

  return {
    version: current.version + 1,
    routes,
  };
}

export function bufferRouteExplorationWeight(
  route: BufferRouteLearningRecord,
  policy: BufferRouteLearningPolicy,
): number {
  if (route.quarantined) return 0;
  return Math.max(policy.explorationFloor, unit((route.score + 1) / 2));
}

export function detectBufferRouteInstability(
  route: BufferRouteLearningRecord,
  policy: BufferRouteLearningPolicy,
): boolean {
  return (
    route.confusionCount >= policy.instabilityThreshold ||
    route.oscillationCount >= policy.instabilityThreshold
  );
}

export function selectBufferRoute(
  state: BufferRingLearningState,
  policy: BufferRouteLearningPolicy,
  deterministicFallbackRouteId?: string,
): BufferRouteSelection {
  if (validateBufferRouteLearningPolicy(policy).length) {
    throw new Error("INVALID_BUFFER_ROUTE_POLICY");
  }
  const viable = Object.values(state.routes)
    .filter(route => !route.quarantined)
    .sort((a, b) => b.score - a.score || a.routeId.localeCompare(b.routeId));

  if (viable.length === 0) {
    return { mode: "NO_ROUTE", routeId: null, score: 0 };
  }

  const top = viable[0];
  const second = viable[1];
  const margin = second ? top.score - second.score : top.score + 1;
  const stable =
    top.samples >= policy.minSamples &&
    top.successes > 0 &&
    top.score > 0 &&
    margin >= policy.hysteresisMargin &&
    !detectBufferRouteInstability(top, policy);

  if (stable) {
    return { mode: "SPECIALIZED", routeId: top.routeId, score: top.score };
  }

  const fallback =
    (deterministicFallbackRouteId &&
      viable.find(route => route.routeId === deterministicFallbackRouteId)) ||
    [...viable].sort((a, b) => a.routeId.localeCompare(b.routeId))[0];
  return { mode: "NEUTRAL", routeId: fallback.routeId, score: fallback.score };
}

function stableState(state: BufferRingLearningState): BufferRingLearningState {
  return {
    version: state.version,
    routes: Object.fromEntries(
      Object.entries(state.routes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([routeId, route]) => [routeId, { ...route }]),
    ),
  };
}

export function checkpointBufferRingLearningState(
  state: BufferRingLearningState,
): string {
  return JSON.stringify(stableState(state));
}

export function restoreBufferRingLearningState(
  checkpoint: string,
): BufferRingLearningState {
  const parsed = JSON.parse(checkpoint) as BufferRingLearningState;
  if (!Number.isSafeInteger(parsed.version) || parsed.version < 0 || !parsed.routes) {
    throw new Error("INVALID_BUFFER_ROUTE_CHECKPOINT");
  }
  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (
      !routeId ||
      route.routeId !== routeId ||
      !Number.isFinite(route.score) ||
      route.score < -1 ||
      route.score > 1 ||
      !Number.isSafeInteger(route.samples) ||
      route.samples < 0 ||
      !Number.isSafeInteger(route.successes) ||
      route.successes < 0 ||
      !Number.isSafeInteger(route.severeFailures) ||
      route.severeFailures < 0 ||
      !Number.isSafeInteger(route.confusionCount) ||
      route.confusionCount < 0 ||
      !Number.isSafeInteger(route.oscillationCount) ||
      route.oscillationCount < 0 ||
      (route.lastPolarity !== null &&
        route.lastPolarity !== "POSITIVE" &&
        route.lastPolarity !== "NEGATIVE") ||
      typeof route.quarantined !== "boolean"
    ) {
      throw new Error("INVALID_BUFFER_ROUTE_CHECKPOINT");
    }
  }
  return stableState(parsed);
}

export function rollbackBufferRingLearningState(
  checkpoint: string,
): BufferRingLearningState {
  return restoreBufferRingLearningState(checkpoint);
}
