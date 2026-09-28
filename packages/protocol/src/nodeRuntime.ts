export const NODE_RUNTIME_CONTRACT_VERSION = "0.1" as const;

export type RuntimeHealth = "ready" | "degraded" | "unavailable";
export type AdapterStatus = "ok" | "rejected" | "failed";

export interface PermissionProfile {
  filesystemRoots: string[];
  networkHosts: string[];
  tools: string[];
  repositories: string[];
  secretRefs: string[];
  allowSideEffects: boolean;
}

export interface RuntimeDescriptor {
  runtimeId: string;
  adapterKind: string;
  version: string;
  executable: string;
  capabilities: string[];
  health: RuntimeHealth;
}

export interface NodeManifest {
  schemaVersion: typeof NODE_RUNTIME_CONTRACT_VERSION;
  nodeId: string;
  generation: number;
  os: string;
  arch: string;
  cpuCores: number;
  memoryMb: number;
  gpu?: string;
  runtimes: RuntimeDescriptor[];
  capabilityIds: string[];
  securityZone: string;
  locality: string;
  resourceLimits: { maxConcurrent: number; memoryMb: number };
  costClass: string;
  health: RuntimeHealth;
  agentVersion: string;
}

export interface ExternalAgentEnvelope<T = unknown> {
  schemaVersion: typeof NODE_RUNTIME_CONTRACT_VERSION;
  adapterKind: string;
  adapterVersion: string;
  nodeId: string;
  generation: number;
  taskId: string;
  actionId: string;
  artifactRefs: string[];
  receiptId: string;
  trustClass: "unverified" | "evaluated";
  payload: T;
}

export interface AdapterReceipt {
  receiptId: string;
  status: AdapterStatus;
  provenance: { adapterKind: string; adapterVersion: string; nodeId: string; generation: number };
  artifactRefs: string[];
  message?: string;
}

export interface AgentRuntimeAdapter {
  readonly kind: string;
  readonly version: string;
  discover(): RuntimeDescriptor | null;
  probe(): RuntimeHealth;
  start(taskId: string, permission: PermissionProfile): string;
  sendContext(sessionId: string, contextRef: string): void;
  observe(sessionId: string): unknown;
  checkpoint(sessionId: string): string;
  resume(checkpointId: string): string;
  cancel(sessionId: string): void;
  health(): RuntimeHealth;
  collectReceipt(sessionId: string): AdapterReceipt;
}

export interface EnrollmentGrant {
  bootstrapToken: string;
  expiresAtMs: number;
  allowedCapabilities: string[];
  securityZone: string;
}

export class NodeEnrollmentRegistry {
  readonly #nodes = new Map<string, NodeManifest>();
  readonly #revoked = new Set<string>();

  enroll(manifest: NodeManifest, grant: EnrollmentGrant, nowMs: number): NodeManifest {
    if (!grant.bootstrapToken || grant.expiresAtMs <= nowMs) throw new Error("ENROLLMENT_GRANT_INVALID");
    if (manifest.nodeId.length < 3 || manifest.generation < 1) throw new Error("NODE_IDENTITY_INVALID");
    if (manifest.capabilityIds.some((id) => !grant.allowedCapabilities.includes(id))) throw new Error("CAPABILITY_SCOPE_REJECTED");
    if (manifest.securityZone !== grant.securityZone) throw new Error("SECURITY_ZONE_REJECTED");
    const previous = this.#nodes.get(manifest.nodeId);
    if (previous && manifest.generation <= previous.generation) throw new Error("STALE_GENERATION");
    this.#nodes.set(manifest.nodeId, structuredClone(manifest));
    this.#revoked.delete(manifest.nodeId);
    return structuredClone(manifest);
  }

  revoke(nodeId: string): void { this.#revoked.add(nodeId); }
  read(nodeId: string): NodeManifest | null {
    const value = this.#nodes.get(nodeId);
    return value ? structuredClone(value) : null;
  }
  isSchedulable(nodeId: string, generation: number, heartbeatAtMs: number, nowMs: number, ttlMs: number): boolean {
    const node = this.#nodes.get(nodeId);
    return !!node && !this.#revoked.has(nodeId) && node.generation === generation &&
      node.health === "ready" && nowMs - heartbeatAtMs <= ttlMs;
  }
}

export function validatePermissionProfile(profile: PermissionProfile): void {
  if (profile.filesystemRoots.includes("/") || profile.networkHosts.includes("*") ||
      profile.tools.includes("*") || profile.repositories.includes("*") || profile.secretRefs.includes("*")) {
    throw new Error("HOST_WIDE_PERMISSION_REJECTED");
  }
}

export function discoverAllowlistedRuntimes(
  candidates: RuntimeDescriptor[],
  allowlistedKinds: readonly string[],
): RuntimeDescriptor[] {
  return candidates.filter((r) => allowlistedKinds.includes(r.adapterKind) && r.health !== "unavailable");
}

export class MockRuntimeAdapter implements AgentRuntimeAdapter {
  readonly #sessions = new Map<string, { taskId: string; checkpoint?: string }>();
  constructor(readonly kind: string, readonly version: string, readonly nodeId: string, readonly generation: number) {}
  discover(): RuntimeDescriptor { return { runtimeId: this.kind, adapterKind: this.kind, version: this.version, executable: "/mock/runtime", capabilities: ["code"], health: "ready" }; }
  probe(): RuntimeHealth { return "ready"; }
  start(taskId: string, permission: PermissionProfile): string { validatePermissionProfile(permission); const id=`${this.kind}:${taskId}`; this.#sessions.set(id,{taskId}); return id; }
  sendContext(sessionId: string, contextRef: string): void { if (!this.#sessions.has(sessionId) || !contextRef) throw new Error("SESSION_OR_CONTEXT_INVALID"); }
  observe(sessionId: string): unknown { const s=this.#sessions.get(sessionId); if(!s) throw new Error("SESSION_NOT_FOUND"); return {taskId:s.taskId}; }
  checkpoint(sessionId: string): string { const s=this.#sessions.get(sessionId); if(!s) throw new Error("SESSION_NOT_FOUND"); const id=`cp:${sessionId}`; s.checkpoint=id; return id; }
  resume(checkpointId: string): string { const original=[...this.#sessions.entries()].find(([,s])=>s.checkpoint===checkpointId); if(!original) throw new Error("CHECKPOINT_NOT_FOUND"); return original[0]; }
  cancel(sessionId: string): void { this.#sessions.delete(sessionId); }
  health(): RuntimeHealth { return "ready"; }
  collectReceipt(sessionId: string): AdapterReceipt { if(!this.#sessions.has(sessionId)) throw new Error("SESSION_NOT_FOUND"); return {receiptId:`receipt:${sessionId}`,status:"ok",provenance:{adapterKind:this.kind,adapterVersion:this.version,nodeId:this.nodeId,generation:this.generation},artifactRefs:[]}; }
}
