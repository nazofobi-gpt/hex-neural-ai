import test from "node:test";
import assert from "node:assert/strict";
import { validateNeutralBufferRing } from "../dist/index.js";

const region = id => ({ id, version: "1", kind: "association", semanticCentroid: [id], ports: [], childRegionIds: [] });
function fixture() {
  const topology = { version: "1", regions: ["foreign","ingress","egress","native"].map(region), projections: [
    { fromRegionId: "foreign", toRegionId: "ingress", schema: "application/json", explicit: true },
    { fromRegionId: "ingress", toRegionId: "egress", schema: "application/json", explicit: true },
    { fromRegionId: "egress", toRegionId: "native", schema: "application/json", explicit: true },
  ]};
  const bridge = { id: "buffer-1", foreignRegionId: "foreign", nativeRegionId: "native", ingressBridgeRegionId: "ingress", egressBridgeRegionId: "egress", logicalClusterLayers: 1, schema: "application/json" };
  const envelope = { schema: "application/json", policyVersion: "policy-v1", sourceRegionId: "foreign", targetRegionId: "native" };
  return { topology, bridge, envelope };
}
test("cold start is neutral", () => { const x=fixture(); const r=validateNeutralBufferRing(x.topology,x.bridge,x.envelope); assert.equal(r.ok,true); assert.equal(r.neutralPrior,0); });
test("direct bypass is rejected", () => { const x=fixture(); x.topology.projections.push({fromRegionId:"foreign",toRegionId:"native",schema:"application/json",explicit:true}); assert.deepEqual(validateNeutralBufferRing(x.topology,x.bridge,x.envelope),{ok:false,code:"DIRECT_BYPASS"}); });
test("missing bridge fails closed", () => { const x=fixture(); x.topology.projections=x.topology.projections.filter(p=>p.fromRegionId!=="egress"); assert.deepEqual(validateNeutralBufferRing(x.topology,x.bridge,x.envelope),{ok:false,code:"MISSING_BRIDGE"}); });
test("depth and envelope guards reject invalid input", () => { const x=fixture(); assert.deepEqual(validateNeutralBufferRing(x.topology,{...x.bridge,logicalClusterLayers:0},x.envelope),{ok:false,code:"INSUFFICIENT_BUFFER_DEPTH"}); assert.deepEqual(validateNeutralBufferRing(x.topology,x.bridge,{...x.envelope,policyVersion:""}),{ok:false,code:"INVALID_ENVELOPE"}); });
