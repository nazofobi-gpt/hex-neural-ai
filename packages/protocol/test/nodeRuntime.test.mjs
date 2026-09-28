import test from "node:test";
import assert from "node:assert/strict";
import {
  NODE_RUNTIME_CONTRACT_VERSION, NodeEnrollmentRegistry, MockRuntimeAdapter,
  discoverAllowlistedRuntimes, validatePermissionProfile,
} from "../dist/index.js";

const permission={filesystemRoots:["/workspace"],networkHosts:["api.example.test"],tools:["git"],repositories:["hex-neural-ai"],secretRefs:[],allowSideEffects:false};
function manifest(generation=1){return {schemaVersion:NODE_RUNTIME_CONTRACT_VERSION,nodeId:"node-a",generation,os:"linux",arch:"x64",cpuCores:4,memoryMb:8192,runtimes:[],capabilityIds:["code"],securityZone:"dev",locality:"local",resourceLimits:{maxConcurrent:2,memoryMb:4096},costClass:"local",health:"ready",agentVersion:"0.1"}}
const grant={bootstrapToken:"one-time",expiresAtMs:2000,allowedCapabilities:["code"],securityZone:"dev"};

test("explicit enrollment is scoped, versioned and stale generations fail closed",()=>{const r=new NodeEnrollmentRegistry();r.enroll(manifest(),grant,1000);assert.equal(r.read("node-a").schemaVersion,"0.1");assert.throws(()=>r.enroll(manifest(),grant,1000),/STALE_GENERATION/);assert.equal(r.isSchedulable("node-a",1,1000,1500,600),true);assert.equal(r.isSchedulable("node-a",1,1000,1700,600),false);r.revoke("node-a");assert.equal(r.isSchedulable("node-a",1,1000,1100,600),false)});

test("expired or over-scoped enrollment is rejected",()=>{const r=new NodeEnrollmentRegistry();assert.throws(()=>r.enroll(manifest(),grant,2000),/ENROLLMENT_GRANT_INVALID/);const m=manifest();m.capabilityIds=["code","shell"];assert.throws(()=>r.enroll(m,grant,1000),/CAPABILITY_SCOPE_REJECTED/)});

test("runtime discovery is allowlisted and unavailable runtimes cannot advertise",()=>{const rows=[{runtimeId:"a",adapterKind:"alpha",version:"1",executable:"/a",capabilities:["code"],health:"ready"},{runtimeId:"b",adapterKind:"beta",version:"1",executable:"/b",capabilities:["code"],health:"ready"},{runtimeId:"c",adapterKind:"alpha",version:"1",executable:"/c",capabilities:["code"],health:"unavailable"}];assert.deepEqual(discoverAllowlistedRuntimes(rows,["alpha"]).map(x=>x.runtimeId),["a"])});

test("two provider-independent adapters satisfy the same lifecycle contract",()=>{for(const kind of ["alpha","beta"]){const a=new MockRuntimeAdapter(kind,"1","node-a",2);assert.equal(a.probe(),"ready");const s=a.start("G-233",permission);a.sendContext(s,"ctx:1");assert.deepEqual(a.observe(s),{taskId:"G-233"});const cp=a.checkpoint(s);assert.equal(a.resume(cp),s);const receipt=a.collectReceipt(s);assert.equal(receipt.status,"ok");assert.equal(receipt.provenance.adapterKind,kind);assert.equal(receipt.provenance.generation,2);a.cancel(s);}});

test("host-wide permission profiles are rejected and secrets are referenced, not embedded",()=>{assert.doesNotThrow(()=>validatePermissionProfile(permission));assert.throws(()=>validatePermissionProfile({...permission,filesystemRoots:["/"]}),/HOST_WIDE_PERMISSION_REJECTED/);assert.throws(()=>validatePermissionProfile({...permission,secretRefs:["*"]}),/HOST_WIDE_PERMISSION_REJECTED/)});
