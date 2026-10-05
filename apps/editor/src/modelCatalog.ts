import type { ConnectionInput } from "./capabilityRegistry";

export type ModelDataClass = "public" | "synthetic" | "internal" | "confidential" | "pii" | "secret";

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
  if (!gate.deterministicFallbackAvailable && profile.fallbackRequired) {
    return { allowed: false, reason: "A deterministic fallback capability is required." };
  }
  if (gate.productionCritical && !profile.productionCriticalAllowed) {
    return { allowed: false, reason: "Experimental models cannot own production-critical execution." };
  }
  if (!profile.allowedDataClasses.includes(gate.dataClass)) {
    return { allowed: false, reason: `Data class ${gate.dataClass} is blocked for this experimental model.` };
  }
  return { allowed: true, reason: null };
}
