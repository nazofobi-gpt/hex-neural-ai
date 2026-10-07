import type { RegionTopology } from "./functional-region.js";

export interface BufferRingBridge {
  id: string;
  foreignRegionId: string;
  nativeRegionId: string;
  ingressBridgeRegionId: string;
  egressBridgeRegionId: string;
  logicalClusterLayers: number;
  schema: string;
}

export interface BufferRingValidationEnvelope {
  schema: string;
  policyVersion: string;
  sourceRegionId: string;
  targetRegionId: string;
}

export type BufferRingValidation =
  | { ok: true; neutralPrior: 0; envelope: BufferRingValidationEnvelope }
  | { ok: false; code: "MISSING_BRIDGE" | "DIRECT_BYPASS" | "INSUFFICIENT_BUFFER_DEPTH" | "INVALID_ENVELOPE" };

export function validateNeutralBufferRing(
  topology: RegionTopology,
  bridge: BufferRingBridge,
  envelope: BufferRingValidationEnvelope,
): BufferRingValidation {
  if (bridge.logicalClusterLayers < 1) return { ok: false, code: "INSUFFICIENT_BUFFER_DEPTH" };
  if (!bridge.ingressBridgeRegionId || !bridge.egressBridgeRegionId) return { ok: false, code: "MISSING_BRIDGE" };
  if (!envelope.schema || !envelope.policyVersion || envelope.sourceRegionId !== bridge.foreignRegionId || envelope.targetRegionId !== bridge.nativeRegionId) {
    return { ok: false, code: "INVALID_ENVELOPE" };
  }
  const direct = topology.projections.some(p =>
    p.explicit && p.fromRegionId === bridge.foreignRegionId && p.toRegionId === bridge.nativeRegionId && p.schema === bridge.schema,
  );
  if (direct) return { ok: false, code: "DIRECT_BYPASS" };
  const ingress = topology.projections.some(p =>
    p.explicit && p.fromRegionId === bridge.foreignRegionId && p.toRegionId === bridge.ingressBridgeRegionId && p.schema === bridge.schema,
  );
  const egress = topology.projections.some(p =>
    p.explicit && p.fromRegionId === bridge.egressBridgeRegionId && p.toRegionId === bridge.nativeRegionId && p.schema === bridge.schema,
  );
  if (!ingress || !egress) return { ok: false, code: "MISSING_BRIDGE" };
  return { ok: true, neutralPrior: 0, envelope };
}
