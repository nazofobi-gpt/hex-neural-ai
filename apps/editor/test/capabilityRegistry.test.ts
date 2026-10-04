import { describe, expect, it } from "vitest";
import { disableCapability, registerCapability, rollbackCapability } from "../src/capabilityRegistry";

const base = { id: "research-mcp", label: "Research MCP", kind: "mcp" as const, protocol: "mcp-2026-07-28", credentialRef: "vault://workspace/research-mcp", permissions: [{ scope: "documents:read", access: "read" as const }] };
const healthy = { authenticated: true, schemaCompatible: true, grantedScopes: ["documents:read"], checkedAt: "2026-10-04T09:48:00.000Z" };

describe("capability registry", () => {
  it("registers a compatible connection using only a secret reference", () => {
    expect(registerCapability(base, healthy)).toMatchObject({ state: "ready", credentialRef: "vault://workspace/research-mcp" });
  });

  it("fails closed for inline credentials, unsupported protocols and missing permission", () => {
    expect(registerCapability({ ...base, credentialRef: "api-key-super-secret" }, healthy)).toMatchObject({ state: "quarantined", reason: expect.stringContaining("vault references") });
    expect(registerCapability({ ...base, protocol: "mcp-unknown" }, healthy)).toMatchObject({ state: "quarantined", reason: expect.stringContaining("Unsupported protocol") });
    expect(registerCapability(base, { ...healthy, grantedScopes: [] })).toMatchObject({ state: "quarantined", reason: expect.stringContaining("documents:read") });
  });

  it("routes authentication failure to reconnect and rolls back reversible changes", () => {
    expect(registerCapability(base, { ...healthy, authenticated: false })).toMatchObject({ state: "degraded", reason: expect.stringContaining("Reconnect") });
    const disabled = disableCapability(registerCapability(base, healthy));
    expect(rollbackCapability(disabled)).toMatchObject({ state: "ready", version: 3, reason: "Rolled back to configuration v1." });
  });
});
