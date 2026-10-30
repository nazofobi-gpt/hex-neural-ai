import type { ConnectionInput } from "./capabilityRegistry";

export type ModelDataClass = "public" | "synthetic" | "internal" | "confidential" | "pii" | "secret";

// Experimental profiles are display metadata, not authority to broaden data access.
const EXPERIMENTAL_SAFE_DATA_CLASSES: ReadonlySet<ModelDataClass> = new Set(["public", "synthetic"]);

// This preview's catalog identity is pinned locally; caller-supplied probe flags
// alone must never authorize a different remote provider, model or endpoint.
const TRUSTED_FLEDGE_IDENTITY = Object.freeze({
  provider: "opencode",
  modelId: "fledge-alpha-free",
  candidateApiBase: "https://opencode.ai/zen/v1",
  connectionId: "opencode/fledge-alpha-free",
});

export interface ExperimentalModelProfile {
  connection: ConnectionInput;
  provider: string;
  modelId: string;
  candidateApiBase: string;
  lifecycle: "experimental";
  availability: "live-probe-required";
  backendIdentity: "opaque";
  productionCriticalAllowed: false;
  allowedDataClasses: readonly ModelDataClass[];
  blockedDataClasses: readonly ModelDataClass[];
  fallbackRequired: true;
}

export interface ExperimentalModelGate {
  liveProbePassed: boolean;
  schemaCompatible: boolean;
  termsVerified: boolean;
  deterministicFallbackAvailable: boolean;
  dataClass: ModelDataClass;
  productionCritical: boolean;
}

export const FLEDGE_ALPHA_PREVIEW: ExperimentalModelProfile = {
  connection: {
    id: "opencode/fledge-alpha-free",
    label: "Fledge Alpha Free",
    kind: "model",
    protocol: "openai-compatible",
    permissions: [{ scope: "model:invoke", access: "write" }],
    metadata: {
      compatibility: ["text", "image", "reasoning", "tool-calls"],
      resourceClass: "remote",
      license: "provider terms",
    },
    priority: 80,
  },
  provider: "opencode",
  modelId: "fledge-alpha-free",
  candidateApiBase: "https://opencode.ai/zen/v1",
  lifecycle: "experimental",
  availability: "live-probe-required",
  backendIdentity: "opaque",
  productionCriticalAllowed: false,
  allowedDataClasses: ["public", "synthetic"],
  blockedDataClasses: ["internal", "confidential", "pii", "secret"],
  fallbackRequired: true,
};

export function evaluateExperimentalModelUse(
  profile: ExperimentalModelProfile,
  gate: ExperimentalModelGate,
): { allowed: boolean; reason: string | null } {
  if (!gate.liveProbePassed) return { allowed: false, reason: "Live provider/model probe is required before activation." };
  if (!gate.schemaCompatible) return { allowed: false, reason: "Provider schema is not compatible with the model capability contract." };
  if (!gate.termsVerified) return { allowed: false, reason: "Current provider terms/privacy policy have not been verified." };
  if (!gate.deterministicFallbackAvailable) {
    return { allowed: false, reason: "A deterministic fallback capability is required." };
  }
  if (gate.productionCritical) {
    return { allowed: false, reason: "Experimental models cannot own production-critical execution." };
  }
  // Caller-provided catalog metadata is not authority to relax experimental safety.
  if (
    profile.lifecycle !== "experimental" ||
    profile.availability !== "live-probe-required" ||
    profile.backendIdentity !== "opaque" ||
    profile.productionCriticalAllowed !== false ||
    profile.fallbackRequired !== true
  ) {
    return { allowed: false, reason: "Experimental model safety invariants are malformed or overridden." };
  }
  const connection = profile.connection;
  // Catalog metadata is mutable at the call site; only the reviewed Fledge
  // identity is permitted until another model receives an explicit binding.
  if (
    profile.provider !== TRUSTED_FLEDGE_IDENTITY.provider ||
    profile.modelId !== TRUSTED_FLEDGE_IDENTITY.modelId ||
    profile.candidateApiBase !== TRUSTED_FLEDGE_IDENTITY.candidateApiBase ||
    connection?.id !== TRUSTED_FLEDGE_IDENTITY.connectionId
  ) {
    return { allowed: false, reason: "Experimental model identity/endpoint does not match the trusted catalog binding." };
  }
  if (
    !connection ||
    connection.kind !== "model" ||
    connection.protocol !== "openai-compatible" ||
    !Array.isArray(connection.permissions) ||
    connection.permissions.length !== 1 ||
    connection.permissions[0]?.scope !== "model:invoke" ||
    connection.permissions[0]?.access !== "write"
  ) {
    return { allowed: false, reason: "Experimental model connection permissions exceed the allowed invocation scope." };
  }
  if (!Array.isArray(profile.allowedDataClasses) || !Array.isArray(profile.blockedDataClasses)) {
    return { allowed: false, reason: "Experimental model data-class policy is malformed." };
  }
  if (!EXPERIMENTAL_SAFE_DATA_CLASSES.has(gate.dataClass) || profile.blockedDataClasses.includes(gate.dataClass)) {
    return { allowed: false, reason: `Data class ${gate.dataClass} is blocked by the experimental model safety policy.` };
  }
  if (!profile.allowedDataClasses.includes(gate.dataClass)) {
    return { allowed: false, reason: `Data class ${gate.dataClass} is blocked for this experimental model.` };
  }
  return { allowed: true, reason: null };
}
