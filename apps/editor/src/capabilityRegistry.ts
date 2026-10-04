export type CapabilityKind = "model" | "tool" | "mcp" | "memory" | "compute";
export type CapabilityState = "draft" | "ready" | "degraded" | "quarantined" | "disabled";

export interface PermissionGrant { scope: string; access: "read" | "write"; }
export interface CapabilityRevision { version: number; state: CapabilityState; credentialRef: string | null; permissions: PermissionGrant[]; checkedAt: string | null; reason: string | null; }
export interface CapabilityRecord extends CapabilityRevision { id: string; label: string; kind: CapabilityKind; protocol: string; history: CapabilityRevision[]; }
export interface ConnectionInput { id: string; label: string; kind: CapabilityKind; protocol: string; credentialRef?: string; permissions: PermissionGrant[]; }
export interface ConnectionProbe { authenticated: boolean; schemaCompatible: boolean; grantedScopes: string[]; checkedAt: string; }

const credentialReference = /^(vault|secret):\/\/[a-z0-9][a-z0-9/_-]*$/i;
const supportedProtocols = new Set(["mcp-2025-11-25", "mcp-2026-07-28", "openai-compatible", "local-runtime"]);

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
  return { ...record, ...previous, version: record.version + 1, permissions: previous.permissions.map((permission) => ({ ...permission })), history: record.history.slice(0, -1), reason: `Rolled back to configuration v${previous.version}.` };
}

function initial(input: ConnectionInput, state: CapabilityState, reason: string | null, checkedAt: string | null = null): CapabilityRecord {
  return { id: input.id, label: input.label, kind: input.kind, protocol: input.protocol, version: 1, state, credentialRef: input.credentialRef?.trim() || null, permissions: input.permissions.map((permission) => ({ ...permission })), checkedAt, reason, history: [] };
}

function revise(record: CapabilityRecord, state: CapabilityState, reason: string): CapabilityRecord {
  const previous: CapabilityRevision = { version: record.version, state: record.state, credentialRef: record.credentialRef, permissions: record.permissions.map((permission) => ({ ...permission })), checkedAt: record.checkedAt, reason: record.reason };
  return { ...record, version: record.version + 1, state, reason, history: [...record.history, previous] };
}
