import { validateGraphDocument } from "./index.js";
import type { SdkGraphValidation } from "./index.js";

export type SdkHttpMethod = "POST";

export interface SdkTransportRequest {
  method: SdkHttpMethod;
  path: "/v1/graphs/validate";
  body: unknown;
}

export interface SdkTransport {
  request(request: SdkTransportRequest): Promise<unknown>;
}

export type SdkClientErrorCode =
  | "INVALID_TRANSPORT_RESPONSE"
  | "UNSUPPORTED_OPERATION";

export class SdkClientError extends Error {
  constructor(
    public readonly code: SdkClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SdkClientError";
  }
}

function isValidation(value: unknown): value is SdkGraphValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.valid === "boolean"
    && (typeof record.protocolVersion === "string" || record.protocolVersion === null)
    && (typeof record.graphId === "string" || record.graphId === null)
    && Array.isArray(record.issues);
}

/**
 * Typed client foundation for the public SDK.
 *
 * This slice exposes validation only. It deliberately has no generic request,
 * auth override, graph execution, deploy, tool invocation, or permission-grant
 * escape hatch. Privileged operations must be introduced as separately typed
 * methods with their own policy contracts.
 */
export class HexApiClient {
  constructor(private readonly transport: SdkTransport) {}

  async validateGraph(graph: unknown): Promise<SdkGraphValidation> {
    const response = await this.transport.request({
      method: "POST",
      path: "/v1/graphs/validate",
      body: graph,
    });
    if (!isValidation(response)) {
      throw new SdkClientError(
        "INVALID_TRANSPORT_RESPONSE",
        "Validation transport returned an invalid response envelope.",
      );
    }
    return response;
  }
}

/**
 * Deterministic local mock used by SDK/CLI tests and offline development.
 * It implements only the explicit validation route and never executes a graph.
 */
export class LocalMockTransport implements SdkTransport {
  async request(request: SdkTransportRequest): Promise<unknown> {
    if (request.method !== "POST" || request.path !== "/v1/graphs/validate") {
      throw new SdkClientError(
        "UNSUPPORTED_OPERATION",
        "Local mock transport only permits graph validation.",
      );
    }
    return validateGraphDocument(request.body);
  }
}
