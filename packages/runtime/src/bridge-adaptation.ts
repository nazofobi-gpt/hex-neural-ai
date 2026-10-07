export interface ContextVector {
  readonly features: Readonly<Record<string, number>>;
  readonly budget: number;
  readonly permissionTags: readonly string[];
}

export interface BridgeCandidate {
  readonly id: string;
  readonly requiredPermission?: string;
  readonly cost: number;
}

export interface BridgePolicyState {
  readonly weights: Readonly<Record<string, number>>;
  readonly eligibility: Readonly<Record<string, number>>;
  readonly explorationRate: number;
  readonly maxExplorationRate: number;
  readonly stepSize: number;
}

export interface AdaptationDecision {
  readonly candidateId: string | null;
  readonly explored: boolean;
  readonly fallbackUsed: boolean;
  readonly allowedCandidateIds: readonly string[];
}

export interface NoveltyProposal {
  readonly kind: "STRUCTURAL_GROWTH_PROPOSAL";
  readonly reason: string;
  readonly mutatesTopology: false;
}

function allowed(context: ContextVector, candidates: readonly BridgeCandidate[]): BridgeCandidate[] {
  const permissions = new Set(context.permissionTags);
  return candidates
    .filter(candidate => candidate.cost <= context.budget)
    .filter(candidate => !candidate.requiredPermission || permissions.has(candidate.requiredPermission))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function score(context: ContextVector, candidate: BridgeCandidate, state: BridgePolicyState): number {
  let total = state.weights[`candidate:${candidate.id}`] ?? 0;
  for (const [name, value] of Object.entries(context.features).sort(([a], [b]) => a.localeCompare(b))) {
    total += (state.weights[`${candidate.id}:${name}`] ?? 0) * value;
  }
  return total;
}

export function selectBridgeCandidate(
  context: ContextVector,
  candidates: readonly BridgeCandidate[],
  state: BridgePolicyState,
  explorationUnit: number,
): AdaptationDecision {
  const pool = allowed(context, candidates);
  if (pool.length === 0) return { candidateId: null, explored: false, fallbackUsed: true, allowedCandidateIds: [] };
  const explorationRate = Math.max(0, Math.min(state.explorationRate, state.maxExplorationRate, 1));
  const explore = explorationUnit >= 0 && explorationUnit < explorationRate;
  const ranked = [...pool].sort((a, b) => score(context, b, state) - score(context, a, state) || a.id.localeCompare(b.id));
  const chosen = explore ? pool[Math.min(pool.length - 1, Math.floor(explorationUnit * pool.length / Math.max(explorationRate, Number.EPSILON)))] : ranked[0];
  return { candidateId: chosen.id, explored: explore, fallbackUsed: false, allowedCandidateIds: pool.map(c => c.id) };
}

export function updateBridgePolicy(
  context: ContextVector,
  candidateId: string,
  reward: number,
  state: BridgePolicyState,
): BridgePolicyState {
  const boundedReward = Math.max(-1, Math.min(1, reward));
  const nextWeights: Record<string, number> = { ...state.weights };
  const nextEligibility: Record<string, number> = {};
  for (const [name, value] of Object.entries(context.features)) {
    const key = `${candidateId}:${name}`;
    const trace = Math.max(-1, Math.min(1, value));
    nextEligibility[key] = trace;
    nextWeights[key] = (nextWeights[key] ?? 0) + state.stepSize * boundedReward * trace;
  }
  const biasKey = `candidate:${candidateId}`;
  nextEligibility[biasKey] = 1;
  nextWeights[biasKey] = (nextWeights[biasKey] ?? 0) + state.stepSize * boundedReward;
  return { ...state, weights: nextWeights, eligibility: nextEligibility };
}

export function proposeStructuralGrowth(novelty: number, threshold: number): NoveltyProposal | null {
  if (!Number.isFinite(novelty) || novelty < threshold) return null;
  return { kind: "STRUCTURAL_GROWTH_PROPOSAL", reason: `novelty:${novelty}`, mutatesTopology: false };
}

export function resetBridgeFastState(state: BridgePolicyState): BridgePolicyState {
  return { ...state, eligibility: {}, explorationRate: 0 };
}
