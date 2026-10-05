import { describe, expect, it } from "vitest";
import { evaluateExperimentalModelUse, FLEDGE_ALPHA_PREVIEW, type ExperimentalModelGate } from "../src/modelCatalog";

const safeGate: ExperimentalModelGate = {
  liveProbePassed: true,
  schemaCompatible: true,
  termsVerified: true,
  deterministicFallbackAvailable: true,
  dataClass: "public",
  productionCritical: false,
};

describe("experimental model catalog", () => {
  it("registers Fledge as an opaque experimental capability rather than a routing authority", () => {
    expect(FLEDGE_ALPHA_PREVIEW).toMatchObject({
      provider: "opencode",
      modelId: "fledge-alpha-free",
      lifecycle: "experimental",
      availability: "live-probe-required",
      backendIdentity: "opaque",
      productionCriticalAllowed: false,
      fallbackRequired: true,
    });
    expect(FLEDGE_ALPHA_PREVIEW.connection).toMatchObject({
      id: "opencode/fledge-alpha-free",
      kind: "model",
      protocol: "openai-compatible",
    });
  });

  it("allows only public or synthetic data after all activation gates pass", () => {
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, safeGate)).toEqual({ allowed: true, reason: null });
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, dataClass: "synthetic" }).allowed).toBe(true);

    for (const dataClass of ["internal", "confidential", "pii", "secret"] as const) {
      expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, dataClass })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("blocked"),
      });
    }
  });

  it("fails closed without live probe, current terms, schema compatibility, fallback or for production-critical work", () => {
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, liveProbePassed: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, termsVerified: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, schemaCompatible: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, deterministicFallbackAvailable: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, productionCritical: true }).allowed).toBe(false);
  });
});
