import { HNAP_PROTOCOL_VERSION, validateGraph } from "@hex-neural/protocol";
import type { HnapGraph } from "@hex-neural/protocol";

/**
 * Experimental, read-only SDK surface (DEV-001 foundation).
 * This module only validates local input. It does not run graphs, send requests,
 * authenticate users, mutate state, or grant extension permissions.
 */
export const SDK_PROTOCOL_VERSION = HNAP_PROTOCOL_VERSION;
export const MAX_GRAPH_JSON_CHARS = 2_000_000;

export type SdkIssueCode =
  | "INPUT_TOO_LARGE"
  | "INVALID_JSON"
  | "MALFORMED_GRAPH"
  | "UNSUPPORTED_PROTOCOL"
  | "INVALID_BUDGET"
  | "CORE_GRAPH_INVALID";

export interface SdkIssue {
  code: SdkIssueCode;
  message: string;
  path?: string;
}

export interface SdkGraphValidation {
  valid: boolean;
  protocolVersion: string | null;
  graphId: string | null;
  issues: SdkIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: SdkIssueCode, message: string, path?: string): SdkGraphValidation {
  return {
    valid: false,
    protocolVersion: null,
    graphId: null,
    issues: [{ code, message, ...(path ? { path } : {}) }],
  };
}

function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCost(value: unknown): boolean {
  return value === null || (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

export function validateGraphDocument(input: unknown): SdkGraphValidation {
  if (!isRecord(input)) {
    return invalid("MALFORMED_GRAPH", "Graph must be a JSON object.");
  }

  const protocolVersion = typeof input.protocolVersion === "string"
    ? input.protocolVersion : null;
  const graphId = typeof input.id === "string" ? input.id : null;
  const failure = (code: SdkIssueCode, message: string, path?: string): SdkGraphValidation => ({
    valid: false,
    protocolVersion,
    graphId,
    issues: [{ code, message, ...(path ? { path } : {}) }],
  });

  if (protocolVersion !== HNAP_PROTOCOL_VERSION) {
    return failure(
      "UNSUPPORTED_PROTOCOL",
      `Only HNAP protocol ${HNAP_PROTOCOL_VERSION} is supported, received ${String(protocolVersion)}.`,
      "protocolVersion",
    );
  }

  if (!graphId?.trim() || typeof input.version !== "string" || !input.version.trim()
      || !Array.isArray(input.nodes) || !Array.isArray(input.connections)
      || (input.clusters !== undefined && !Array.isArray(input.clusters))
      || (input.neuralCircuits !== undefined && !Array.isArray(input.neuralCircuits))) {
    return failure("MALFORMED_GRAPH", "Missing or invalid required graph identity/collections.");
  }

  const budget = input.resourceBudget;
  if (!isRecord(budget)
      || !positiveInt(budget.maxHops)
      || !(typeof budget.maxRuntimeMs === "number" && Number.isFinite(budget.maxRuntimeMs) && budget.maxRuntimeMs > 0)
      || !nonNegativeInt(budget.maxExternalCalls)
      || !boundedCost(budget.maxCostUnits)) {
    return failure("INVALID_BUDGET", "Finite positive runtime and non-negative call/cost budgets are required.", "resourceBudget");
  }

  try {
    const core = validateGraph(input as unknown as HnapGraph);
    return {
      valid: core.valid,
      protocolVersion,
      graphId,
      issues: core.issues.map(issue => ({
        code: "CORE_GRAPH_INVALID" as const,
        message: `${issue.code}: ${issue.message}`,
        ...(issue.path ? { path: issue.path } : {}),
      })),
    };
  } catch {
    // Untrusted JSON must never crash an SDK caller or reach runtime execution.
    return failure("MALFORMED_GRAPH", "Malformed nested graph structure was rejected.");
  }
}

export function validateGraphJson(text: string): SdkGraphValidation {
  if (typeof text !== "string") {
    return invalid("INVALID_JSON", "Graph input must be a JSON string.");
  }
  if (text.length > MAX_GRAPH_JSON_CHARS) {
    return invalid("INPUT_TOO_LARGE", `Graph JSON exceeds ${MAX_GRAPH_JSON_CHARS} characters.`);
  }
  try {
    return validateGraphDocument(JSON.parse(text) as unknown);
  } catch {
    return invalid("INVALID_JSON", "Graph input is not valid JSON.");
  }
}

export { HexApiClient, LocalMockTransport, SdkClientError } from "./client.js";
export type { SdkTransport, SdkTransportRequest, SdkHttpMethod, SdkClientErrorCode } from "./client.js";
