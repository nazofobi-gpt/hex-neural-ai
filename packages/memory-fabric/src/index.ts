export type MemoryScope = "global" | `project:${string}` | `task:${string}`;

export interface SourceVersion {
  sourceId: string;
  version: string;
  checksum: string;
  scope: MemoryScope;
  content: string;
}

export interface MemoryChunk {
  id: string;
  sourceId: string;
  sourceVersion: string;
  checksum: string;
  scope: MemoryScope;
  text: string;
  ordinal: number;
}

export interface RecallHit {
  chunk: MemoryChunk;
  score: number;
}

interface StoredSource {
  source: Readonly<SourceVersion>;
  chunkSize: number;
}

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const tokenSet = (value: string) => new Set(normalize(value).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
const sourceKey = (sourceId: string, version: string) => JSON.stringify([sourceId, version]);
const chunkId = (s: SourceVersion, ordinal: number, text: string) =>
  `${s.sourceId.length}:${s.sourceId}${s.version.length}:${s.version}:${ordinal}:${simpleDigest(text)}`;

export function simpleDigest(value: string): string {
  let h = 2166136261;
  for (const ch of value) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class MemoryFabric {
  private readonly sources = new Map<string, StoredSource>();
  private readonly chunks = new Map<string, MemoryChunk>();

  ingest(source: SourceVersion, chunkSize = 240): MemoryChunk[] {
    if (!source.sourceId || !source.version || !source.checksum || !source.scope) throw new Error("INVALID_SOURCE_PROVENANCE");
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("INVALID_CHUNK_SIZE");
    const key = sourceKey(source.sourceId, source.version);
    if (this.sources.has(key)) return this.chunksFor(source.sourceId, source.version);
    const text = normalize(source.content);
    if (!text) throw new Error("EMPTY_SOURCE");
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) parts.push(text.slice(i, i + chunkSize));
    const seen = new Set<string>();
    const created: MemoryChunk[] = [];
    for (let ordinal = 0; ordinal < parts.length; ordinal++) {
      const part = parts[ordinal];
      const digest = simpleDigest(part);
      if (seen.has(digest)) continue;
      seen.add(digest);
      const chunk: MemoryChunk = {
        id: chunkId(source, ordinal, part), sourceId: source.sourceId, sourceVersion: source.version,
        checksum: source.checksum, scope: source.scope, text: part, ordinal
      };
      this.chunks.set(chunk.id, chunk);
      created.push(chunk);
    }
    this.sources.set(key, Object.freeze({source: Object.freeze({...source}), chunkSize}));
    return created;
  }

  recall(query: string, allowedScopes: readonly MemoryScope[]): RecallHit[] {
    const q = tokenSet(query);
    if (q.size === 0) return [];
    return [...this.chunks.values()]
      .filter(c => allowedScopes.includes(c.scope))
      .map(chunk => {
        const t = tokenSet(chunk.text);
        let overlap = 0;
        for (const token of q) if (t.has(token)) overlap++;
        return {chunk, score: overlap / q.size};
      })
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  }

  removeSource(sourceId: string, version: string): number {
    this.sources.delete(sourceKey(sourceId, version));
    let removed = 0;
    for (const [id, chunk] of this.chunks) {
      if (chunk.sourceId === sourceId && chunk.sourceVersion === version) {
        this.chunks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  rebuild(): void {
    const versions = [...this.sources.values()];
    this.chunks.clear();
    this.sources.clear();
    for (const {source, chunkSize} of versions) this.ingest(source, chunkSize);
  }

  private chunksFor(sourceId: string, version: string): MemoryChunk[] {
    return [...this.chunks.values()].filter(c => c.sourceId === sourceId && c.sourceVersion === version);
  }
}
