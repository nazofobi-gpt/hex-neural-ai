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
    expect(rollbackCapability(disabled)).toMatchObject({ state: "disabled", version: 3, reason: expect.stringContaining("fresh provider verification required") });
  });

  it("never restores ready via rollback without a new provider-bound probe", async () => {
    const ready = registerCapability(base, healthy);
    const disabled = disableCapability(ready);
    const rolled = rollbackCapability(disabled);
    expect(rolled.state).toBe("disabled");
    expect(rolled.checkedAt).toBe(disabled.checkedAt);
    expect(selectFallback([rolled], "documents:read")).toBeNull();

    const now = Date.parse("2026-10-24T00:48:00.000Z");
    const proof = async (request: { capabilityId: string; credentialRef: string | null; challenge: string }) => ({
      ...healthy, checkedAt: new Date(now).toISOString(),
      capabilityId: request.capabilityId, credentialRef: request.credentialRef, challenge: request.challenge,
    });
    const reverified = await verifyAndEnableCapability(rolled, proof, () => now);
    expect(reverified.state).toBe("ready");

    // Even a ready-to-ready configuration rollback must invalidate old permission proof.
    const readyWithHistory = {
      ...ready, version: 2,
      history: [{
        version: 1, state: "ready" as const,
        credentialRef: "vault://workspace/old",
        permissions: [{ scope: "documents:write", access: "write" as const }],
        checkedAt: healthy.checkedAt, reason: null,
      }],
    };
    const restored = rollbackCapability(readyWithHistory);
    expect(restored.state).toBe("degraded");
    expect(restored.credentialRef).toBe("vault://workspace/old");
    expect(selectFallback([restored], "documents:write")).toBeNull();
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

  it("requires a live, capability-bound auth/schema/scope probe to re-enable", async () => {
    const now = Date.parse("2026-10-23T21:50:00.000Z");
    const fresh = { ...healthy, checkedAt: new Date(now).toISOString() };
    const disabled = disableCapability(registerCapability(base, healthy));
    const proof = (overrides: Record<string, unknown> = {}) => async (request: { capabilityId: string; credentialRef: string | null; challenge: string }) =>
      ({ ...fresh, capabilityId: request.capabilityId, credentialRef: request.credentialRef, challenge: request.challenge, ...overrides });

    await expect(verifyAndEnableCapability(disabled, proof(), () => now)).resolves.toMatchObject({
      state: "ready", version: 3, checkedAt: fresh.checkedAt, reason: expect.stringContaining("fresh provider-bound"),
    });
    expect((await verifyAndEnableCapability(disabled, proof({ grantedScopes: [] }), () => now)).state).toBe("quarantined");
    expect((await verifyAndEnableCapability(disabled, proof({ authenticated: false }), () => now)).state).toBe("degraded");
  });

  it("rejects stale, replayed, future, malformed and mismatched re-enable proofs", async () => {
    const now = Date.parse("2026-10-23T21:50:00.000Z");
    const disabled = disableCapability(registerCapability(base, healthy));
    const proof = (overrides: Record<string, unknown> = {}) => async (request: { capabilityId: string; credentialRef: string | null; challenge: string }) =>
      ({ ...healthy, checkedAt: new Date(now).toISOString(), capabilityId: request.capabilityId, credentialRef: request.credentialRef, challenge: request.challenge, ...overrides });

    for (const override of [
      { checkedAt: healthy.checkedAt },
      { checkedAt: new Date(now + 1000).toISOString() },
      { checkedAt: "not-a-timestamp" },
      { capabilityId: "different-capability" },
      { credentialRef: "vault://different/credential" },
      { challenge: "replayed-challenge" },
    ]) {
      expect((await verifyAndEnableCapability(disabled, proof(override), () => now)).state).toBe("quarantined");
    }
    const alreadyChecked = disableCapability({ ...registerCapability(base, healthy), checkedAt: new Date(now).toISOString() });
    expect((await verifyAndEnableCapability(alreadyChecked, proof(), () => now)).state).toBe("quarantined");
    expect((await verifyAndEnableCapability(disabled, async () => { throw new Error("provider unreachable"); }, () => now)).state).toBe("disabled");
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

  it("rejects URL authority spoofing and malformed local-runtime endpoints", () => {
    const cases = [
      ["safe-loopback", "http://127.0.0.1:11434", true],
      ["safe-unix", "unix:///tmp/hex.sock", true],
      ["remote-ip-prefix", "http://127.0.0.1.evil.example", false],
      ["remote-localhost-prefix", "http://localhost.evil.example", false],
      ["remote-userinfo", "http://localhost@evil.example", false],
      ["remote-port-userinfo", "http://127.0.0.1:8080@evil.example", false],
      ["invalid-port", "http://localhost:99999", false],
      ["ambiguous-unix-path", "unix:////remote/hex.sock", false],
      ["query-bearing", "http://localhost?next=https://evil.example", false],
      ["fragment-bearing", "http://localhost#@evil.example", false],
    ] as const;
    const result = discoverLocalRuntimes(cases.map(([id, endpoint]) => ({
      id, label: id, endpoint, compatibility: ["text"], license: "MIT", signatureVerified: true,
    })));
    expect(result.accepted.map(({ id }) => id)).toEqual(["safe-loopback", "safe-unix"]);
    expect(result.rejected.map(({ id }) => id).sort()).toEqual(
      cases.filter(([, , safe]) => !safe).map(([id]) => id).sort(),
    );
  });
});
