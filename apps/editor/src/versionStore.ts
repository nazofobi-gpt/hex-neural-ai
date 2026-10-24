/**
 * G-263 / VER-001 slice: durable, project-scoped, single-writer graph checkpoints.
 *
 * The storage adapter is synchronous but NOT a cross-tab/process CAS primitive.
 * Callers must serialize writers externally. A thrown write is UNKNOWN: reload and
 * reconcile by actionId before deciding whether any further action is safe.
 * Restore creates a new checkpoint; it never reverses external side effects.
 */
export interface VersionNode {
  id: string;
  label: string;
  q: number;
  r: number;
}

export interface VersionSnapshot {
  nodes: VersionNode[];
  nextSequence: number;
}

export interface VersionRecord {
  id: string;
  actionId: string;
  parentId: string | null;
  label: string;
  createdAt: string;
  snapshot: VersionSnapshot;
  restoredFromId?: string;
}

export interface VersionDocument {
  schemaVersion: 1;
  projectId: string;
  headId: string | null;
  versions: VersionRecord[];
}

export interface VersionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CheckpointInput {
  id: string;
  actionId: string;
  expectedHeadId: string | null;
  label: string;
  createdAt: string;
  snapshot: VersionSnapshot;
  restoredFromId?: string;
}

function invalid(code: string): never {
  throw new Error(code);
}

function required(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function normalizeSnapshot(value: unknown): VersionSnapshot {
  if (!value || typeof value !== "object") invalid("INVALID_SNAPSHOT");
  const candidate = value as Partial<VersionSnapshot>;
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length > 5000 ||
      !Number.isSafeInteger(candidate.nextSequence) || (candidate.nextSequence ?? 0) < 1) {
    invalid("INVALID_SNAPSHOT");
  }
  const ids = new Set<string>();
  const positions = new Set<string>();
  const nodes = candidate.nodes.map((raw) => {
    if (!raw || !required(raw.id) || typeof raw.label !== "string" ||
        raw.label.length > 512 || !Number.isSafeInteger(raw.q) ||
        !Number.isSafeInteger(raw.r)) invalid("INVALID_SNAPSHOT");
    const position = `${raw.q},${raw.r}`;
    if (ids.has(raw.id) || positions.has(position)) invalid("INVALID_SNAPSHOT");
    ids.add(raw.id);
    positions.add(position);
    return { id: raw.id, label: raw.label, q: raw.q, r: raw.r };
  });
  return { nodes, nextSequence: candidate.nextSequence as number };
}

function normalizeRecord(value: unknown, parentId: string | null): VersionRecord {
  if (!value || typeof value !== "object") invalid("CORRUPT_HISTORY");
  const record = value as Partial<VersionRecord>;
  if (!required(record.id) || !required(record.actionId) ||
      !required(record.label) || typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      record.parentId !== parentId ||
      (record.restoredFromId !== undefined && !required(record.restoredFromId))) {
    invalid("CORRUPT_HISTORY");
  }
  return {
    id: record.id,
    actionId: record.actionId,
    parentId,
    label: record.label,
    createdAt: record.createdAt,
    snapshot: normalizeSnapshot(record.snapshot),
    ...(record.restoredFromId ? { restoredFromId: record.restoredFromId } : {}),
  };
}

export class VersionStore {
  public readonly storageKey: string;

  public constructor(
    private readonly storage: VersionStorage,
    private readonly projectId: string,
  ) {
    if (!required(projectId)) invalid("INVALID_PROJECT");
    this.storageKey = `hex.versionHistory.v1.${encodeURIComponent(projectId)}`;
  }

  public load(): VersionDocument {
    const raw = this.storage.getItem(this.storageKey);
    if (raw === null) {
      return { schemaVersion: 1, projectId: this.projectId, headId: null, versions: [] };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return invalid("CORRUPT_HISTORY");
    }
    if (!decoded || typeof decoded !== "object") invalid("CORRUPT_HISTORY");
    const document = decoded as Partial<VersionDocument>;
    if (document.schemaVersion !== 1 || document.projectId !== this.projectId ||
        !Array.isArray(document.versions) || document.versions.length > 512) {
      invalid("CORRUPT_HISTORY");
    }
    const ids = new Set<string>();
    const actions = new Set<string>();
    let previous: string | null = null;
    const versions = document.versions.map((entry) => {
      const record = normalizeRecord(entry, previous);
      if (ids.has(record.id) || actions.has(record.actionId) ||
          (record.restoredFromId && !ids.has(record.restoredFromId))) {
        invalid("CORRUPT_HISTORY");
      }
      ids.add(record.id);
      actions.add(record.actionId);
      previous = record.id;
      return record;
    });
    if (document.headId !== previous) invalid("CORRUPT_HISTORY");
    return { schemaVersion: 1, projectId: this.projectId, headId: previous, versions };
  }

  public checkpoint(input: CheckpointInput): VersionRecord {
    if (!required(input.id) || !required(input.actionId) ||
        !required(input.label) || !Number.isFinite(Date.parse(input.createdAt))) {
      invalid("INVALID_CHECKPOINT");
    }
    const snapshot = normalizeSnapshot(input.snapshot);
    const current = this.load();
    const duplicate = current.versions.find((record) => record.actionId === input.actionId);
    if (duplicate) {
      const same = duplicate.id === input.id &&
        duplicate.parentId === input.expectedHeadId &&
        duplicate.label === input.label &&
        duplicate.createdAt === input.createdAt &&
        duplicate.restoredFromId === input.restoredFromId &&
        JSON.stringify(duplicate.snapshot) === JSON.stringify(snapshot);
      if (!same) invalid("ACTION_CONFLICT");
      return duplicate;
    }
    if (current.headId !== input.expectedHeadId) invalid("HEAD_CONFLICT");
    if (current.versions.some((record) => record.id === input.id)) invalid("VERSION_ID_CONFLICT");
    if (input.restoredFromId &&
        !current.versions.some((record) => record.id === input.restoredFromId)) {
      invalid("MISSING_RESTORE_TARGET");
    }
    if (current.versions.length >= 512) invalid("HISTORY_LIMIT");
    const record: VersionRecord = {
      id: input.id,
      actionId: input.actionId,
      parentId: current.headId,
      label: input.label,
      createdAt: input.createdAt,
      snapshot,
      ...(input.restoredFromId ? { restoredFromId: input.restoredFromId } : {}),
    };
    const encoded = JSON.stringify({
      ...current, headId: record.id, versions: [...current.versions, record],
    });
    try {
      this.storage.setItem(this.storageKey, encoded);
      if (this.storage.getItem(this.storageKey) !== encoded) {
        invalid("WRITE_UNKNOWN_RECONCILE_REQUIRED");
      }
    } catch {
      invalid("WRITE_UNKNOWN_RECONCILE_REQUIRED");
    }
    return record;
  }

  public restore(input: Omit<CheckpointInput, "snapshot"> & { targetId: string }): VersionRecord {
    const target = this.load().versions.find((record) => record.id === input.targetId);
    if (!target) invalid("MISSING_RESTORE_TARGET");
    return this.checkpoint({
      id: input.id,
      actionId: input.actionId,
      expectedHeadId: input.expectedHeadId,
      label: input.label,
      createdAt: input.createdAt,
      snapshot: target.snapshot,
      restoredFromId: target.id,
    });
  }

  public exportJson(): string {
    return JSON.stringify(this.load());
  }
}
