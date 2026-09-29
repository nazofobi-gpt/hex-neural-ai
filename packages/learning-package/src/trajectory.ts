export type TrajectorySplit = "train" | "validation" | "test";
export type TrajectoryOrigin = "real" | "synthetic";
export interface TrajectoryExample {
  schemaVersion: "1";
  trajectoryId: string;
  datasetVersion: string;
  sourcePackageId: string;
  context: string;
  action: string;
  result: string;
  outcome: "success" | "failure";
  evaluator: { id: string; version: string; label: string };
  qualityLabel: "accepted" | "rejected";
  split: TrajectorySplit;
  origin: TrajectoryOrigin;
}
export interface TrajectoryDataset {
  schemaVersion: "1";
  datasetVersion: string;
  examples: readonly TrajectoryExample[];
  counts: { train: number; validation: number; test: number; real: number; synthetic: number };
}
export function buildTrajectoryDataset(datasetVersion: string, input: readonly TrajectoryExample[]): TrajectoryDataset {
  if (!datasetVersion.trim()) throw new Error("DATASET_VERSION_REQUIRED");
  const seen = new Map<string, TrajectorySplit>();
  for (const e of input) {
    if (e.schemaVersion !== "1" || e.datasetVersion !== datasetVersion || !e.trajectoryId || !e.sourcePackageId) throw new Error("INVALID_PROVENANCE");
    if (!e.evaluator.id || !e.evaluator.version || !e.evaluator.label) throw new Error("UNTRACEABLE_EVALUATOR");
    if ([e.context, e.action, e.result].some(v => v.includes("[REDACTED_SECRET]"))) throw new Error("SECRET_DETECTED");
    const prior = seen.get(e.trajectoryId);
    if (prior && prior !== e.split) throw new Error("SPLIT_LEAKAGE");
    if (prior) throw new Error("DUPLICATE_TRAJECTORY");
    seen.set(e.trajectoryId, e.split);
  }
  const examples = [...input].sort((a,b) => a.trajectoryId.localeCompare(b.trajectoryId));
  const count = (key: "split"|"origin", value: string) => examples.filter(e => e[key] === value).length;
  return { schemaVersion:"1", datasetVersion, examples, counts:{
    train:count("split","train"), validation:count("split","validation"), test:count("split","test"),
    real:count("origin","real"), synthetic:count("origin","synthetic")
  }};
}
