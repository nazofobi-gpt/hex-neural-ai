import assert from "node:assert/strict";
import test from "node:test";
import { intakeModelCapsule } from "../dist/index.js";

const manifest=()=>({schemaVersion:"1",modelId:"tiny-model",sourceVersion:"v1",sourceUri:"fixture://tiny",usageRights:{verified:true,basis:"fixture-license"},artifacts:{weights:{format:"safetensors",checksum:{algorithm:"sha256",value:"9a129038d9a00aed0cf6a7ea059ca50a813449061ab87848cf1a13eafdf33b2c"}},config:"config.json",tokenizer:"tokenizer.json"},architecture:"tiny-transformer",dtype:"float16",limits:{contextTokens:1024},resources:{memoryMb:64},eval:{suite:"m0-fixture",version:"1"},requiresRemoteCode:false});

test("verified capsule is deeply immutable and detached from input",async()=>{
 const m=manifest();const c=await intakeModelCapsule(m,"weights");
 assert.equal(c.status,"VERIFIED");assert.equal(c.capsuleId,"tiny-model@v1");
 assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.manifest));assert.ok(Object.isFrozen(c.manifest.usageRights));
 assert.ok(Object.isFrozen(c.manifest.artifacts.weights.checksum));assert.ok(Object.isFrozen(c.manifest.limits));
 assert.ok(Object.isFrozen(c.manifest.resources));assert.ok(Object.isFrozen(c.manifest.eval));
 assert.throws(()=>{c.manifest.usageRights.basis="tampered";},TypeError);
 assert.throws(()=>{c.manifest.artifacts.weights.checksum.value="0".repeat(64);},TypeError);
 m.usageRights.basis="mutated-input";m.resources.memoryMb=999;m.eval.version="2";
 assert.equal(c.manifest.usageRights.basis,"fixture-license");assert.equal(c.manifest.resources.memoryMb,64);assert.equal(c.manifest.eval.version,"1");
});

test("quarantined capsules are also deeply immutable",async()=>{
 const c=await intakeModelCapsule(manifest(),"tampered");
 assert.equal(c.status,"QUARANTINED");assert.equal(c.quarantineReason,"CHECKSUM_MISMATCH");
 assert.ok(Object.isFrozen(c.manifest.artifacts.weights.checksum));
 assert.throws(()=>{c.manifest.eval.suite="changed";},TypeError);
});

test("unverified rights are blocked",async()=>{const m=manifest();m.usageRights={verified:false,basis:""};const c=await intakeModelCapsule(m,"weights");assert.equal(c.status,"BLOCKED_SOURCE");});
test("remote code and unsafe serialization default deny",async()=>{const a=manifest();a.requiresRemoteCode=true;assert.equal((await intakeModelCapsule(a,"weights")).quarantineReason,"REMOTE_CODE_DENIED");const b=manifest();b.artifacts.weights.format="pickle";assert.equal((await intakeModelCapsule(b,"weights")).quarantineReason,"UNSAFE_SERIALIZATION");});
