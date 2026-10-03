export type ArtifactKind = "memory" | "skill" | "adapter";
export type ArtifactStatus = "ACTIVE" | "DISABLED" | "DELETED";

export interface SourceRecord { id: string; version: string; digest: string }
export interface ArtifactInput {
  id: string;
  kind: ArtifactKind;
  version: string;
  sourceIds: readonly string[];
  parentArtifactIds?: readonly string[];
}
export interface ArtifactRecord extends ArtifactInput {
  parentArtifactIds: readonly string[];
  status: ArtifactStatus;
}
export interface EpisodeInput { id: string; timestampMs: number; sourceId: string; summary: string }
export interface RegressionDecision {
  accepted: boolean;
  meanDrop: number;
  action: "PROMOTE" | "PROMOTION_FROZEN";
}
export interface RemovalResult {
  sourceId: string;
  disabledArtifactIds: readonly string[];
  remediation: ReadonlyArray<{ artifactId: string; action: "DELETE_OR_RETRAIN" }>;
}
export interface Checkpoint { schema: "CONTINUAL_LIFECYCLE_V1"; payload: string; checksum: string }

interface StoredEpisode extends EpisodeInput {}
interface State {
  sources: SourceRecord[];
  artifacts: ArtifactRecord[];
  episodes: StoredEpisode[];
}

const uniqueSorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
const cloneSource = (value: SourceRecord): SourceRecord => ({ ...value });
const cloneArtifact = (value: ArtifactRecord): ArtifactRecord => ({
  ...value,
  sourceIds: [...value.sourceIds],
  parentArtifactIds: [...value.parentArtifactIds],
});
const cloneEpisode = (value: StoredEpisode): StoredEpisode => ({ ...value });

// FNV-1a is deterministic and dependency-free; it detects accidental checkpoint corruption.
const checksum = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export class ContinualLifecycle {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly episodes = new Map<string, StoredEpisode>();

  registerSource(source: SourceRecord): SourceRecord {
    if (!source.id || !source.version || !source.digest) throw new Error("INVALID_SOURCE");
    if (this.sources.has(source.id)) throw new Error(`SOURCE_EXISTS:${source.id}`);
    const stored = cloneSource(source);
    this.sources.set(stored.id, stored);
    return cloneSource(stored);
  }

  registerArtifact(input: ArtifactInput): ArtifactRecord {
    if (!input.id || !input.version || input.sourceIds.length === 0) throw new Error("INVALID_ARTIFACT");
    if (this.artifacts.has(input.id)) throw new Error(`ARTIFACT_EXISTS:${input.id}`);
    const sourceIds = uniqueSorted(input.sourceIds);
    const parentArtifactIds = uniqueSorted(input.parentArtifactIds ?? []);
    for (const id of sourceIds) if (!this.sources.has(id)) throw new Error(`UNKNOWN_SOURCE:${id}`);
    for (const id of parentArtifactIds) {
      const parent = this.artifacts.get(id);
      if (!parent) throw new Error(`UNKNOWN_PARENT:${id}`);
      if (parent.status !== "ACTIVE") throw new Error(`INACTIVE_PARENT:${id}`);
    }
    const stored: ArtifactRecord = { ...input, sourceIds, parentArtifactIds, status: "ACTIVE" };
    this.artifacts.set(stored.id, stored);
    return cloneArtifact(stored);
  }

  removeSource(sourceId: string): RemovalResult {
    if (!this.sources.delete(sourceId)) throw new Error(`UNKNOWN_SOURCE:${sourceId}`);
    const affected = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const artifact of this.artifacts.values()) {
        if (artifact.status !== "ACTIVE" || affected.has(artifact.id)) continue;
        if (artifact.sourceIds.includes(sourceId) || artifact.parentArtifactIds.some((id) => affected.has(id))) {
          affected.add(artifact.id);
          changed = true;
        }
      }
    }
    const ids = [...affected].sort();
    for (const id of ids) this.artifacts.get(id)!.status = "DISABLED";
    for (const [id, episode] of this.episodes) if (episode.sourceId === sourceId) this.episodes.delete(id);
    return {
      sourceId,
      disabledArtifactIds: ids,
      remediation: ids.map((artifactId) => ({ artifactId, action: "DELETE_OR_RETRAIN" as const })),
    };
  }

  deleteArtifact(id: string): ArtifactRecord {
    const artifact = this.requireArtifact(id);
    if (artifact.status !== "DISABLED") throw new Error(`DELETE_REQUIRES_DISABLED:${id}`);
    artifact.status = "DELETED";
    return cloneArtifact(artifact);
  }

  retrainArtifact(disabledId: string, replacement: ArtifactInput): ArtifactRecord {
    const previous = this.requireArtifact(disabledId);
    if (previous.status !== "DISABLED") throw new Error(`RETRAIN_REQUIRES_DISABLED:${disabledId}`);
    return this.registerArtifact(replacement);
  }

  recordEpisode(input: EpisodeInput, maxSummaryLength = 512): void {
    if (!this.sources.has(input.sourceId)) throw new Error(`UNKNOWN_SOURCE:${input.sourceId}`);
    if (!Number.isFinite(input.timestampMs) || input.summary.length > maxSummaryLength) throw new Error("INVALID_EPISODE");
    this.episodes.set(input.id, cloneEpisode(input));
  }

  enforceRetention(nowMs: number, maxAgeMs: number, maxEntries: number): readonly string[] {
    if (maxAgeMs < 0 || maxEntries < 0) throw new Error("INVALID_RETENTION_POLICY");
    const removed: string[] = [];
    for (const [id, episode] of this.episodes) {
      if (nowMs - episode.timestampMs > maxAgeMs) { this.episodes.delete(id); removed.push(id); }
    }
    const kept = [...this.episodes.values()].sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
    for (const episode of kept.slice(maxEntries)) { this.episodes.delete(episode.id); removed.push(episode.id); }
    return uniqueSorted(removed);
  }

  evaluateOldTaskRegression(
    baselineScores: Readonly<Record<string, number>>,
    candidateScores: Readonly<Record<string, number>>,
    maxMeanDrop: number,
  ): RegressionDecision {
    const tasks = Object.keys(baselineScores).sort();
    if (tasks.length === 0 || maxMeanDrop < 0) throw new Error("INVALID_REGRESSION_INPUT");
    const totalDrop = tasks.reduce((sum, task) => {
      if (!(task in candidateScores)) throw new Error(`MISSING_CANDIDATE_SCORE:${task}`);
      return sum + Math.max(0, baselineScores[task]! - candidateScores[task]!);
    }, 0);
    const meanDrop = totalDrop / tasks.length;
    return { accepted: meanDrop <= maxMeanDrop, meanDrop, action: meanDrop <= maxMeanDrop ? "PROMOTE" : "PROMOTION_FROZEN" };
  }

  checkpoint(): Checkpoint {
    const state = this.snapshot();
    const payload = JSON.stringify(state);
    return { schema: "CONTINUAL_LIFECYCLE_V1", payload, checksum: checksum(payload) };
  }

  static fromCheckpoint(checkpoint: Checkpoint): ContinualLifecycle {
    if (checkpoint.schema !== "CONTINUAL_LIFECYCLE_V1" || checksum(checkpoint.payload) !== checkpoint.checksum) {
      throw new Error("INVALID_CHECKPOINT");
    }
    const state = JSON.parse(checkpoint.payload) as State;
    const restored = new ContinualLifecycle();
    for (const source of state.sources) restored.sources.set(source.id, cloneSource(source));
    for (const artifact of state.artifacts) restored.artifacts.set(artifact.id, cloneArtifact(artifact));
    for (const episode of state.episodes) restored.episodes.set(episode.id, cloneEpisode(episode));
    return restored;
  }

  snapshot(): State {
    return {
      sources: [...this.sources.values()].map(cloneSource).sort((a, b) => a.id.localeCompare(b.id)),
      artifacts: [...this.artifacts.values()].map(cloneArtifact).sort((a, b) => a.id.localeCompare(b.id)),
      episodes: [...this.episodes.values()].map(cloneEpisode).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  residualRisks(): readonly string[] {
    return [
      "External replicas and backups require provider-specific erasure confirmation.",
      "Incomplete source attribution can leave untracked derived artifacts.",
      "Regression replay quality is bounded by the coverage of its old-task fixtures.",
    ];
  }

  private requireArtifact(id: string): ArtifactRecord {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`UNKNOWN_ARTIFACT:${id}`);
    return artifact;
  }
}
