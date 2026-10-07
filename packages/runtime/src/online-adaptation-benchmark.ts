import {
  selectBridgeCandidate,
  updateBridgePolicy,
  type BridgePolicyState,
} from "./bridge-adaptation.js";
import {
  BoundedReplayReservoir,
  type ReplayExample,
} from "./online-adaptation-state.js";

export interface AdaptationMetrics {
  calls: number;
  completionRate: number;
  routeAccuracy: number;
  regret: number;
  p95LatencyMs: number | null;
  totalCost: number;
  entropyBits: number;
  calibrationError: number;
}

export interface AdaptationBenchmarkResult {
  schema: "G228_ONLINE_ADAPTATION_BENCHMARK_V1";
  evalSetId: string;
  replayCapacity: number;
  replaySize: number;
  adaptationStepsToFirstCorrect: number | null;
  oldContextAccuracyBefore: number;
  oldContextAccuracyAfter: number;
  oldContextAccuracyDrop: number;
  forgettingGuardPass: boolean;
  adapted: AdaptationMetrics;
  deterministic: AdaptationMetrics;
  verdict: "ADAPTED_POLICY" | "DETERMINISTIC_DEFAULT";
  finalState: BridgePolicyState;
}

export interface AdaptationBenchmarkInput {
  evalSetId: string;
  replayCapacity: number;
  training: readonly ReplayExample[];
  oldContextEval: readonly ReplayExample[];
  newContextEval: readonly ReplayExample[];
  initialState: BridgePolicyState;
  deterministicCandidateId: string;
  maxOldContextAccuracyDrop: number;
  clockMs: () => number;
}

interface Observation {
  candidateId: string | null;
  correct: boolean;
  reward: number;
  maxReward: number;
  latencyMs: number;
  cost: number;
  confidence: number;
}

function p95(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function entropy(ids: readonly (string | null)[]): number {
  if (!ids.length) return 0;
  const counts = new Map<string, number>();
  for (const id of ids) {
    const key = id ?? "<fallback>";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) {
    const probability = count / ids.length;
    total -= probability * Math.log2(probability);
  }
  return total;
}

function confidence(state: BridgePolicyState, candidateId: string | null): number {
  if (!candidateId) return 0;
  const bias = state.weights[`candidate:${candidateId}`] ?? 0;
  return 1 / (1 + Math.exp(-bias));
}

function policyObservations(
  examples: readonly ReplayExample[],
  state: BridgePolicyState,
  clockMs: () => number,
): Observation[] {
  return examples.map(example => {
    const started = clockMs();
    const decision = selectBridgeCandidate(
      example.context,
      example.candidates,
      { ...state, explorationRate: 0 },
      1,
    );
    const latencyMs = Math.max(0, clockMs() - started);
    const selected = example.candidates.find(candidate => candidate.id === decision.candidateId);
    const rewards = Object.values(example.rewards);
    const maxReward = rewards.length ? Math.max(...rewards) : 0;
    return {
      candidateId: decision.candidateId,
      correct: decision.candidateId === example.expectedCandidateId,
      reward: decision.candidateId ? example.rewards[decision.candidateId] ?? 0 : 0,
      maxReward,
      latencyMs,
      cost: selected?.cost ?? 0,
      confidence: confidence(state, decision.candidateId),
    };
  });
}

function baselineObservations(
  examples: readonly ReplayExample[],
  candidateId: string,
  clockMs: () => number,
): Observation[] {
  return examples.map(example => {
    const started = clockMs();
    const candidate = example.candidates.find(item => item.id === candidateId);
    const allowed =
      candidate !== undefined &&
      candidate.cost <= example.context.budget &&
      (!candidate.requiredPermission ||
        example.context.permissionTags.includes(candidate.requiredPermission));
    const selected = allowed ? candidateId : null;
    const latencyMs = Math.max(0, clockMs() - started);
    const rewards = Object.values(example.rewards);
    const maxReward = rewards.length ? Math.max(...rewards) : 0;
    return {
      candidateId: selected,
      correct: selected === example.expectedCandidateId,
      reward: selected ? example.rewards[selected] ?? 0 : 0,
      maxReward,
      latencyMs,
      cost: allowed ? candidate!.cost : 0,
      confidence: allowed ? 1 : 0,
    };
  });
}

function summarize(observations: readonly Observation[]): AdaptationMetrics {
  if (!observations.length) {
    return {
      calls: 0,
      completionRate: 0,
      routeAccuracy: 0,
      regret: 0,
      p95LatencyMs: null,
      totalCost: 0,
      entropyBits: 0,
      calibrationError: 0,
    };
  }
  return {
    calls: observations.length,
    completionRate:
      observations.filter(item => item.candidateId !== null).length /
      observations.length,
    routeAccuracy:
      observations.filter(item => item.correct).length / observations.length,
    regret:
      observations.reduce(
        (sum, item) => sum + Math.max(0, item.maxReward - item.reward),
        0,
      ) / observations.length,
    p95LatencyMs: p95(observations.map(item => item.latencyMs)),
    totalCost: observations.reduce((sum, item) => sum + item.cost, 0),
    entropyBits: entropy(observations.map(item => item.candidateId)),
    calibrationError:
      observations.reduce(
        (sum, item) => sum + Math.abs(item.confidence - (item.correct ? 1 : 0)),
        0,
      ) / observations.length,
  };
}

function accuracy(observations: readonly Observation[]): number {
  return observations.length
    ? observations.filter(item => item.correct).length / observations.length
    : 0;
}

export function runAdaptationAcceptanceBenchmark(
  input: AdaptationBenchmarkInput,
): AdaptationBenchmarkResult {
  if (
    !input.evalSetId.trim() ||
    input.oldContextEval.length === 0 ||
    input.newContextEval.length === 0 ||
    !Number.isFinite(input.maxOldContextAccuracyDrop) ||
    input.maxOldContextAccuracyDrop < 0 ||
    input.maxOldContextAccuracyDrop > 1
  ) {
    throw new Error("ADAPTATION_BENCHMARK_INVALID");
  }

  const replay = new BoundedReplayReservoir(input.replayCapacity);
  const oldEval = structuredClone(input.oldContextEval);
  const newEval = structuredClone(input.newContextEval);
  const oldBefore = policyObservations(oldEval, input.initialState, input.clockMs);
  let state = structuredClone(input.initialState);
  let adaptationStepsToFirstCorrect: number | null = null;

  input.training.forEach((example, index) => {
    replay.push(example);
    const decision = selectBridgeCandidate(
      example.context,
      example.candidates,
      state,
      1,
    );
    if (
      adaptationStepsToFirstCorrect === null &&
      decision.candidateId === example.expectedCandidateId
    ) {
      adaptationStepsToFirstCorrect = index + 1;
    }
    if (decision.candidateId) {
      state = updateBridgePolicy(
        example.context,
        decision.candidateId,
        example.rewards[decision.candidateId] ?? 0,
        state,
      );
    }
  });

  const combinedEval = [...oldEval, ...newEval];
  const adaptedObservations = policyObservations(combinedEval, state, input.clockMs);
  const deterministicObservations = baselineObservations(
    combinedEval,
    input.deterministicCandidateId,
    input.clockMs,
  );
  const oldAfter = adaptedObservations.slice(0, oldEval.length);
  const oldContextAccuracyBefore = accuracy(oldBefore);
  const oldContextAccuracyAfter = accuracy(oldAfter);
  const oldContextAccuracyDrop = Math.max(
    0,
    oldContextAccuracyBefore - oldContextAccuracyAfter,
  );
  const forgettingGuardPass =
    oldContextAccuracyDrop <= input.maxOldContextAccuracyDrop;
  const adapted = summarize(adaptedObservations);
  const deterministic = summarize(deterministicObservations);

  return {
    schema: "G228_ONLINE_ADAPTATION_BENCHMARK_V1",
    evalSetId: input.evalSetId,
    replayCapacity: replay.capacity,
    replaySize: replay.size,
    adaptationStepsToFirstCorrect,
    oldContextAccuracyBefore,
    oldContextAccuracyAfter,
    oldContextAccuracyDrop,
    forgettingGuardPass,
    adapted,
    deterministic,
    verdict:
      forgettingGuardPass &&
      adapted.routeAccuracy > deterministic.routeAccuracy &&
      adapted.regret <= deterministic.regret
        ? "ADAPTED_POLICY"
        : "DETERMINISTIC_DEFAULT",
    finalState: structuredClone(state),
  };
}
