import type { ReenableProbeProvider } from "./capabilityRegistry";

/**
 * Transport boundary for a deployment-owned capability gateway.
 * The gateway, not this browser module, resolves vault references and proves
 * upstream identity/auth/schema/grants. Never accept a URL from a capability form.
 */
export interface TrustedGatewayConfig {
  endpoint: string;
  expectedOrigin: string;
  gatewayId: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const vaultRef = /^(vault|secret):\/\/[a-z0-9][a-z0-9/_-]*$/i;
const PROBE_PATH = "/api/capabilities/probe";

function trustedEndpoint(config: TrustedGatewayConfig): URL {
  const origin = new URL(config.expectedOrigin);
  const endpoint = new URL(config.endpoint);
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
    || origin.pathname !== "/" || origin.search || origin.hash
    || origin.username || origin.password
    || endpoint.origin !== origin.origin || endpoint.pathname !== PROBE_PATH
    || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
    || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(config.gatewayId)
  ) {
    throw new Error("Trusted capability gateway identity/configuration is invalid.");
  }
  return endpoint;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a live probe provider for verifyAndEnableCapability, not a
 * configuration-only proof. No gateway endpoint is provisioned by this module.
 */
export function createTrustedGatewayProbe(config: TrustedGatewayConfig): ReenableProbeProvider {
  const endpoint = trustedEndpoint(config);
  const timeoutMs = config.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15000) {
    throw new Error("Trusted gateway timeout must be bounded.");
  }

  return async (request) => {
    if (
      !request.capabilityId || !request.challenge || !request.protocol
      || (request.credentialRef !== null && !vaultRef.test(request.credentialRef))
      || !Array.isArray(request.permissions)
      || request.permissions.some((p) => !p.scope || !["read", "write"].includes(p.access))
    ) {
      throw new Error("Capability probe request is invalid.");
    }

    // The only credential value crossing the boundary is an opaque vault ref.
    // Session auth, if used, is restricted to the same-origin trusted gateway.
    const response = await (config.fetcher ?? globalThis.fetch)(endpoint.href, {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        gatewayId: config.gatewayId,
        capabilityId: request.capabilityId,
        protocol: request.protocol,
        credentialRef: request.credentialRef,
        permissions: request.permissions,
        challenge: request.challenge,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new Error("Trusted capability gateway proof unavailable.");
    }
    const body: unknown = await response.json();
    if (
      !isObject(body) || body.schemaVersion !== 1
      || body.gatewayId !== config.gatewayId || body.protocol !== request.protocol
      || body.capabilityId !== request.capabilityId
      || body.credentialRef !== request.credentialRef
      || body.challenge !== request.challenge
      || typeof body.authenticated !== "boolean"
      || typeof body.schemaCompatible !== "boolean"
      || typeof body.checkedAt !== "string"
      || !Array.isArray(body.grantedScopes)
      || !body.grantedScopes.every((scope: unknown) => typeof scope === "string" && scope.length > 0)
    ) {
      // Do not interpolate provider data or error bodies: they may include secrets.
      throw new Error("Trusted capability gateway proof is invalid or unbound.");
    }

    return {
      capabilityId: request.capabilityId,
      credentialRef: request.credentialRef,
      challenge: request.challenge,
      authenticated: body.authenticated,
      schemaCompatible: body.schemaCompatible,
      grantedScopes: body.grantedScopes as string[],
      checkedAt: body.checkedAt,
    };
  };
}
