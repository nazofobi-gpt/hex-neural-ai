import { describe, expect, it } from "vitest";
import { disableCapability, discoverLocalRuntimes, recordHealth, registerCapability, rollbackCapability, selectFallback, verifyAndEnableCapability } from "../src/capabilityRegistry";

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

  it("selects only healthy, permission-compatible fallbacks deterministically", () => {
    const remote = registerCapability({ ...base, id: "remote", priority: 20, metadata: { resourceClass: "remote", license: "Apache-2.0", compatibility: ["text"] } }, healthy);
    const local = registerCapability({ ...base, id: "local", priority: 10, protocol: "local-runtime", credentialRef: undefined, metadata: { resourceClass: "local", license: "MIT", compatibility: ["text"] } }, healthy);
    const blocked = disableCapability({ ...local, id: "blocked", priority: 1 });
    expect(selectFallback([remote, blocked, local], "documents:read")?.id).toBe("local");
    expect(selectFallback([remote], "documents:write")).toBeNull();
  });

  it("keeps bounded health history and never auto-enables a disabled capability", () => {
    let record = registerCapability(base, healthy);
    for (let index = 0; index < 7; index += 1) record = recordHealth(record, { state: index === 6 ? "offline" : "healthy", checkedAt: `2026-10-04T10:0${index}:00.000Z`, detail: `probe-${index}` });
    expect(record).toMatchObject({ state: "degraded", health: expect.arrayContaining([expect.objectContaining({ detail: "probe-6" })]) });
    expect(record.health).toHaveLength(5);
    const disabled = disableCapability(record);
    expect(recordHealth(disabled, { state: "healthy", checkedAt: healthy.checkedAt, detail: "recovered" }).state).toBe("disabled");
  });

  it("requires a fresh auth, schema and permission probe before re-enable", () => {
    const disabled = disableCapability(registerCapability(base, healthy));
    expect(verifyAndEnableCapability(disabled, { ...healthy, grantedScopes: [] }).state).toBe("quarantined");
    expect(verifyAndEnableCapability(disabled, healthy)).toMatchObject({ state: "ready", version: 3, reason: expect.stringContaining("Re-enabled") });
  });

  it("discovers only verified loopback or unix runtimes", () => {
    const result = discoverLocalRuntimes([
      { id: "local-a", label: "Local A", endpoint: "http://127.0.0.1:11434", compatibility: ["text"], license: "MIT", signatureVerified: true },
      { id: "remote", label: "Remote", endpoint: "https://example.com", compatibility: ["text"], license: "unknown", signatureVerified: true },
      { id: "unsigned", label: "Unsigned", endpoint: "unix:///tmp/hex.sock", compatibility: ["embeddings"], license: "MIT", signatureVerified: false },
    ]);
    expect(result.accepted.map(({ id }) => id)).toEqual(["local-a"]);
    expect(result.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ id: "remote" }), expect.objectContaining({ id: "unsigned" })]));
  });
});
