import { describe, expect, it } from "vitest";
import { evaluateExperimentalModelUse, FLEDGE_ALPHA_PREVIEW, type ExperimentalModelGate, type ExperimentalModelProfile } from "../src/modelCatalog";

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

  it("rejects tampered profile allowlists, deny conflicts and production-critical overrides", () => {
    const tampered = {
      ...FLEDGE_ALPHA_PREVIEW,
      allowedDataClasses: ["public", "synthetic", "internal", "secret"],
      blockedDataClasses: [],
      productionCriticalAllowed: true,
      fallbackRequired: false,
    } as unknown as ExperimentalModelProfile;
    for (const dataClass of ["internal", "secret"] as const) {
      expect(evaluateExperimentalModelUse(tampered, { ...safeGate, dataClass })).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("blocked"),
      });
    }
    expect(evaluateExperimentalModelUse(tampered, { ...safeGate, productionCritical: true }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(tampered, { ...safeGate, deterministicFallbackAvailable: false }).allowed).toBe(false);

    const denyWins = { ...FLEDGE_ALPHA_PREVIEW, blockedDataClasses: ["public"] as const };
    expect(evaluateExperimentalModelUse(denyWins, safeGate).allowed).toBe(false);
    const malformed = { ...FLEDGE_ALPHA_PREVIEW, blockedDataClasses: null } as unknown as ExperimentalModelProfile;
    expect(evaluateExperimentalModelUse(malformed, safeGate).allowed).toBe(false);
  });

  it("rejects overridden lifecycle flags and elevated connection privileges", () => {
    const variants: ExperimentalModelProfile[] = [
      { ...FLEDGE_ALPHA_PREVIEW, lifecycle: "ready" } as unknown as ExperimentalModelProfile,
      { ...FLEDGE_ALPHA_PREVIEW, availability: "available" } as unknown as ExperimentalModelProfile,
      { ...FLEDGE_ALPHA_PREVIEW, backendIdentity: "trusted" } as unknown as ExperimentalModelProfile,
      { ...FLEDGE_ALPHA_PREVIEW, productionCriticalAllowed: true } as unknown as ExperimentalModelProfile,
      { ...FLEDGE_ALPHA_PREVIEW, fallbackRequired: false } as unknown as ExperimentalModelProfile,
    ];
    for (const profile of variants) {
      expect(evaluateExperimentalModelUse(profile, safeGate)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("invariants"),
      });
    }
    const extraScope = {
      ...FLEDGE_ALPHA_PREVIEW,
      connection: {
        ...FLEDGE_ALPHA_PREVIEW.connection,
        permissions: [
          ...FLEDGE_ALPHA_PREVIEW.connection.permissions,
          { scope: "workspace:admin", access: "write" },
        ],
      },
    } as unknown as ExperimentalModelProfile;
    expect(evaluateExperimentalModelUse(extraScope, safeGate)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("permissions"),
    });
    const wrongKind = {
      ...FLEDGE_ALPHA_PREVIEW,
      connection: { ...FLEDGE_ALPHA_PREVIEW.connection, kind: "tool" },
    } as unknown as ExperimentalModelProfile;
    expect(evaluateExperimentalModelUse(wrongKind, safeGate).allowed).toBe(false);
    const noPermissions = {
      ...FLEDGE_ALPHA_PREVIEW,
      connection: { ...FLEDGE_ALPHA_PREVIEW.connection, permissions: [] },
    } as ExperimentalModelProfile;
    expect(evaluateExperimentalModelUse(noPermissions, safeGate).allowed).toBe(false);
  });

  it("fails closed without live probe, current terms, schema compatibility, fallback or for production-critical work", () => {
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, liveProbePassed: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, termsVerified: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, schemaCompatible: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, deterministicFallbackAvailable: false }).allowed).toBe(false);
    expect(evaluateExperimentalModelUse(FLEDGE_ALPHA_PREVIEW, { ...safeGate, productionCritical: true }).allowed).toBe(false);
  });
});
