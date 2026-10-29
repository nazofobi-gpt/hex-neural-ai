export type CapabilityKind = "model" | "tool" | "mcp" | "memory" | "compute";
export type CapabilityState = "draft" | "ready" | "degraded" | "quarantined" | "disabled";

export interface PermissionGrant { scope: string; access: "read" | "write"; }
export interface CapabilityMetadata { compatibility: string[]; resourceClass: "local" | "remote" | "hybrid"; license: string; }
export interface HealthObservation { state: "healthy" | "degraded" | "offline"; checkedAt: string; detail: string; }
export interface CapabilityRevision { version: number; state: CapabilityState; credentialRef: string | null; permissions: PermissionGrant[]; checkedAt: string | null; reason: string | null; }
export interface CapabilityRecord extends CapabilityRevision { id: string; label: string; kind: CapabilityKind; protocol: string; metadata: CapabilityMetadata; priority: number; health: HealthObservation[]; history: CapabilityRevision[]; }
export interface ConnectionInput { id: string; label: string; kind: CapabilityKind; protocol: string; credentialRef?: string; permissions: PermissionGrant[]; metadata?: Partial<CapabilityMetadata>; priority?: number; }
export interface ConnectionProbe { authenticated: boolean; schemaCompatible: boolean; grantedScopes: string[]; checkedAt: string; }
export interface ReenableProbe extends ConnectionProbe { capabilityId: string; credentialRef: string | null; challenge: string; }
export interface ReenableProbeRequest { capabilityId: string; protocol: string; credentialRef: string | null; permissions: PermissionGrant[]; challenge: string; }
export type ReenableProbeProvider = (request: ReenableProbeRequest) => Promise<ReenableProbe>;
export interface LocalRuntimeCandidate { id: string; label: string; endpoint: string; compatibility: string[]; license: string; signatureVerified: boolean; }
export interface DiscoveryResult { accepted: ConnectionInput[]; rejected: Array<{ id: string; reason: string }>; }

const credentialReference = /^(vault|secret):\/\/[a-z0-9][a-z0-9/_-]*$/i;
const supportedProtocols = new Set(["mcp-2025-11-25", "mcp-2026-07-28", "openai-compatible", "local-runtime"]);

/** Local form validation is not a provider handshake. Never promote a preview connection. */
export function stageCapabilityForVerification(input: ConnectionInput): CapabilityRecord {
  if (!supportedProtocols.has(input.protocol)) {
    return initial(input, "quarantined", `Unsupported protocol: ${input.protocol}`);
  }
  const credentialRef = input.credentialRef?.trim() || null;
  if (credentialRef && !credentialReference.test(credentialRef)) {
    return initial(input, "quarantined", "Credentials must be stored as vault references, never inline values.");
  }
  return initial(input, "draft", "Live provider authentication, schema and granted scopes have not been verified.");
}

export function registerCapability(input: ConnectionInput, probe: ConnectionProbe): CapabilityRecord {
  if (!supportedProtocols.has(input.protocol)) return initial(input, "quarantined", `Unsupported protocol: ${input.protocol}`);
  const credentialRef = input.credentialRef?.trim() || null;
  if (credentialRef && !credentialReference.test(credentialRef)) return initial(input, "quarantined", "Credentials must be stored as vault references, never inline values.");
  if (!probe.authenticated) return initial(input, "degraded", "Authentication failed. Reconnect the credential reference.", probe.checkedAt);
  if (!probe.schemaCompatible) return initial(input, "quarantined", "Provider schema is incompatible with this capability contract.", probe.checkedAt);
  const missing = input.permissions.filter((permission) => !probe.grantedScopes.includes(permission.scope));
  if (missing.length) return initial(input, "quarantined", `Permission denied: ${missing.map(({ scope }) => scope).join(", ")}.`, probe.checkedAt);
  return initial(input, "ready", null, probe.checkedAt);
}

export function disableCapability(record: CapabilityRecord, reason = "Disabled by workspace owner."): CapabilityRecord {
  return revise(record, "disabled", reason);
}

export function rollbackCapability(record: CapabilityRecord): CapabilityRecord {
  const previous = record.history.at(-1);
  if (!previous) return record;
  // Restoring an old configuration must not resurrect an old auth/scope probe.
  // A formerly ready revision needs a new provider-bound verification before use.
  const requiresReverification = previous.state === "ready";
  const state: CapabilityState = requiresReverification
    ? record.state === "disabled" || record.state === "quarantined" ? record.state : "degraded"
    : previous.state;
  return {
    ...record,
    ...previous,
    version: record.version + 1,
    state,
    permissions: previous.permissions.map((permission) => ({ ...permission })),
    checkedAt: requiresReverification ? record.checkedAt : previous.checkedAt,
    history: record.history.slice(0, -1),
    reason: requiresReverification
      ? `Rolled back configuration v${previous.version}; fresh provider verification required before enabling.`
      : `Rolled back to configuration v${previous.version}.`,
  };
}

export function selectFallback(records: CapabilityRecord[], requiredScope: string): CapabilityRecord | null {
  return [...records]
    .filter((record) => record.state === "ready" && record.permissions.some(({ scope }) => scope === requiredScope))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0] ?? null;
}

export function recordHealth(record: CapabilityRecord, observation: HealthObservation): CapabilityRecord {
  const health = [...record.health, { ...observation }].slice(-5);
  if (record.state !== "ready" || observation.state === "healthy") return { ...record, health };
  return { ...revise(record, "degraded", `Health check ${observation.state}: ${observation.detail}`), health };
}

export async function verifyAndEnableCapability(
  record: CapabilityRecord,
  probeProvider: ReenableProbeProvider,
  now: () => number = Date.now,
): Promise<CapabilityRecord> {
  if (!(["disabled", "degraded", "quarantined"] as CapabilityState[]).includes(record.state)) return record;
  if (typeof probeProvider !== "function" || (record.credentialRef && !credentialReference.test(record.credentialRef))) {
    return revise(record, "quarantined", "A valid credential reference and live provider probe are required.");
  }

  try {
    const startedAt = now();
    const challenge = globalThis.crypto.randomUUID();
    const probe = await probeProvider({
      capabilityId: record.id,
      protocol: record.protocol,
      credentialRef: record.credentialRef,
      permissions: record.permissions.map((permission) => ({ ...permission })),
      challenge,
    });
    const completedAt = now();
    const checkedAt = Date.parse(probe.checkedAt);
    const previousCheck = record.checkedAt ? Date.parse(record.checkedAt) : -Infinity;
    const bound = probe.capabilityId === record.id
      && probe.credentialRef === record.credentialRef
      && probe.challenge === challenge;
    const fresh = Number.isFinite(startedAt) && Number.isFinite(completedAt)
      && completedAt >= startedAt && Number.isFinite(checkedAt)
      && checkedAt >= startedAt && checkedAt <= completedAt
      && checkedAt > previousCheck;
    if (!bound || !fresh) {
      return revise(record, "quarantined", "Stale, replayed, future-dated or unbound provider proof rejected.");
    }

    const verified = registerCapability({
      id: record.id, label: record.label, kind: record.kind, protocol: record.protocol,
      credentialRef: record.credentialRef ?? undefined, permissions: record.permissions,
      metadata: record.metadata, priority: record.priority,
    }, probe);
    return {
      ...revise(record, verified.state, verified.state === "ready"
        ? "Re-enabled after fresh provider-bound auth, schema and permission probe."
        : verified.reason ?? "Verification failed."),
      checkedAt: probe.checkedAt,
    };
  } catch {
    return revise(record, record.state, "Live provider probe failed; capability was not enabled.");
  }
}

function isLocalRuntimeEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
        && parsed.username === "" && parsed.password === ""
        && parsed.search === "" && parsed.hash === "";
    }
    if (parsed.protocol === "unix:") {
      return endpoint.startsWith("unix:///") && parsed.host === ""
        && parsed.pathname.startsWith("/") && !parsed.pathname.startsWith("//")
        && parsed.pathname.length > 1 && parsed.search === "" && parsed.hash === "";
    }
  } catch {
    // Malformed URLs must not become import candidates.
  }
  return false;
}

export function discoverLocalRuntimes(candidates: LocalRuntimeCandidate[]): DiscoveryResult {
  const accepted: ConnectionInput[] = [];
  const rejected: DiscoveryResult["rejected"] = [];
  for (const candidate of candidates) {
    const localEndpoint = isLocalRuntimeEndpoint(candidate.endpoint);
    if (!localEndpoint) { rejected.push({ id: candidate.id, reason: "Remote endpoints cannot be imported by local discovery." }); continue; }
    if (!candidate.signatureVerified) { rejected.push({ id: candidate.id, reason: "Runtime signature is unverified." }); continue; }
    accepted.push({ id: candidate.id, label: candidate.label, kind: "compute", protocol: "local-runtime", permissions: [{ scope: "runtime:execute", access: "write" }], metadata: { compatibility: [...candidate.compatibility], resourceClass: "local", license: candidate.license } });
  }
  return { accepted: accepted.sort((a, b) => a.id.localeCompare(b.id)), rejected };
}

function safeCredentialRef(raw: string | undefined): string | null {
  const value = raw?.trim() || null;
  return value && credentialReference.test(value) ? value : null;
}

function initial(input: ConnectionInput, state: CapabilityState, reason: string | null, checkedAt: string | null = null): CapabilityRecord {
  return { id: input.id, label: input.label, kind: input.kind, protocol: input.protocol, metadata: { compatibility: [...(input.metadata?.compatibility ?? [])], resourceClass: input.metadata?.resourceClass ?? "remote", license: input.metadata?.license ?? "unknown" }, priority: input.priority ?? 100, version: 1, state, credentialRef: safeCredentialRef(input.credentialRef), permissions: input.permissions.map((permission) => ({ ...permission })), checkedAt, reason, health: [], history: [] };
}

function revise(record: CapabilityRecord, state: CapabilityState, reason: string): CapabilityRecord {
  const previous: CapabilityRevision = { version: record.version, state: record.state, credentialRef: record.credentialRef, permissions: record.permissions.map((permission) => ({ ...permission })), checkedAt: record.checkedAt, reason: record.reason };
  return { ...record, version: record.version + 1, state, reason, history: [...record.history, previous] };
}
