import { describe, expect, it } from "vitest";
import { disableCapability, registerCapability, verifyAndEnableCapability } from "../src/capabilityRegistry";
import { createTrustedGatewayProbe } from "../src/trustedGatewayProbe";

const input = {
  id: "provider-mcp", label: "Provider MCP", kind: "mcp" as const,
  protocol: "mcp-2026-07-28", credentialRef: "vault://team/provider",
  permissions: [{ scope: "documents:read", access: "read" as const }],
};
const at = Date.parse("2026-10-30T02:50:00.000Z");
const now = () => at;
const initialProof = {
  authenticated: true, schemaCompatible: true, grantedScopes: ["documents:read"],
  checkedAt: "2026-10-01T00:00:00.000Z",
};
const disabled = disableCapability(registerCapability(input, initialProof));
const endpoint = "https://example.test/api/capabilities/probe";

function gateway(overrides: Record<string, unknown> = {}, status = 200, type = "application/json") {
  const seen: { url?: string; options?: RequestInit; body?: Record<string, unknown> } = {};
  const fetcher: typeof fetch = async (url, options) => {
    seen.url = String(url);
    seen.options = options;
    seen.body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      ...seen.body, authenticated: true, schemaCompatible: true,
      grantedScopes: ["documents:read"], checkedAt: new Date(at).toISOString(),
      ...overrides,
    }), { status, headers: { "Content-Type": type } });
  };
  const probe = createTrustedGatewayProbe({
    endpoint, expectedOrigin: "https://example.test", gatewayId: "trusted-gateway",
    fetcher, timeoutMs: 2000,
  });
  return { probe, seen };
}

describe("trusted capability gateway adapter", () => {
  it("sends only an opaque reference to a pinned same-origin endpoint and enables on fresh bound proof", async () => {
    const { probe, seen } = gateway();
    const record = await verifyAndEnableCapability(disabled, probe, now);
    expect(record.state).toBe("ready");
    expect(seen.url).toBe(endpoint);
    expect(seen.options).toMatchObject({
      method: "POST", mode: "same-origin", redirect: "error",
      cache: "no-store", credentials: "same-origin",
    });
    expect(seen.body).toMatchObject({
      gatewayId: "trusted-gateway", schemaVersion: 1,
      credentialRef: "vault://team/provider", capabilityId: "provider-mcp",
    });
    expect(JSON.stringify(seen.body)).not.toContain("sk-test-");
  });

  it("rejects attacker-controlled gateway origins, untrusted HTTP and ambiguous URLs", () => {
    for (const bad of [
      "https://example.test.evil.test/api/capabilities/probe",
      "https://example.test@evil.test/api/capabilities/probe",
      "https://example.test/api/capabilities/probe?redirect=1",
      "https://example.test/api/other",
      "http://example.test/api/capabilities/probe",
    ]) {
      expect(() => createTrustedGatewayProbe({
        endpoint: bad, expectedOrigin: new URL(bad).protocol === "http:" ? "http://example.test" : "https://example.test",
        gatewayId: "trusted-gateway",
      })).toThrow();
    }
  });

  it("fails closed for gateway identity/replay, invalid type, and unavailable server", async () => {
    for (const proof of [
      { gatewayId: "another-gateway" }, { protocol: "wrong" },
      { capabilityId: "wrong" }, { credentialRef: "vault://wrong" },
      { challenge: "replayed" }, { authenticated: "true" },
      { schemaVersion: 0 }, { grantedScopes: [123] },
    ]) {
      expect((await verifyAndEnableCapability(disabled, gateway(proof).probe, now)).state).toBe("disabled");
    }
    expect((await verifyAndEnableCapability(disabled, gateway({}, 503).probe, now)).state).toBe("disabled");
    expect((await verifyAndEnableCapability(disabled, gateway({}, 200, "text/html").probe, now)).state).toBe("disabled");
  });

  it("keeps absent grants, failed auth, and incompatible schema out of ready", async () => {
    expect((await verifyAndEnableCapability(disabled, gateway({ grantedScopes: [] }).probe, now)).state).toBe("quarantined");
    expect((await verifyAndEnableCapability(disabled, gateway({ authenticated: false }).probe, now)).state).toBe("degraded");
    expect((await verifyAndEnableCapability(disabled, gateway({ schemaCompatible: false }).probe, now)).state).toBe("quarantined");
  });

  it("rejects inline credentials before any request, and never serializes them", async () => {
    let requests = 0;
    const probe = createTrustedGatewayProbe({
      endpoint, expectedOrigin: "https://example.test", gatewayId: "trusted-gateway",
      fetcher: async () => { requests += 1; throw new Error("should not run"); },
    });
    await expect(probe({
      capabilityId: input.id, protocol: input.protocol, credentialRef: "sk-test-PRIVATE",
      permissions: input.permissions, challenge: "bound",
    })).rejects.toThrow("invalid");
    expect(requests).toBe(0);
  });
});
