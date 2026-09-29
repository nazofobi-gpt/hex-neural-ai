import assert from "node:assert/strict";
import test from "node:test";
import { buildTrajectoryDataset } from "../dist/index.js";
const ex=(id,split,origin="synthetic")=>({schemaVersion:"1",trajectoryId:id,datasetVersion:"a3-v1",sourcePackageId:"fixture@v1",context:"ctx",action:"act",result:"ok",outcome:id==="fail"?"failure":"success",evaluator:{id:"eval",version:"1",label:id==="fail"?"bad":"good"},qualityLabel:"accepted",split,origin});
test("trajectory fixture is deterministic with provenance and origin separation",()=>{const a=buildTrajectoryDataset("a3-v1",[ex("z","test","real"),ex("a","train"),ex("v","validation")]);const b=buildTrajectoryDataset("a3-v1",[ex("v","validation"),ex("z","test","real"),ex("a","train")]);assert.deepEqual(a,b);assert.deepEqual(a.examples.map(x=>x.trajectoryId),["a","v","z"]);assert.deepEqual(a.counts,{train:1,validation:1,test:1,real:1,synthetic:2});assert.equal(a.examples[0].sourcePackageId,"fixture@v1");assert.equal(a.examples[0].evaluator.id,"eval");});
test("split leakage fails closed",()=>assert.throws(()=>buildTrajectoryDataset("a3-v1",[ex("same","train"),ex("same","test")]),/SPLIT_LEAKAGE/));
test("redacted secret markers fail closed",()=>{const x=ex("secret","train");x.context="[REDACTED_SECRET]";assert.throws(()=>buildTrajectoryDataset("a3-v1",[x]),/SECRET_DETECTED/);});
test("untraceable evaluator fails closed",()=>{const x=ex("bad","train");x.evaluator={id:"",version:"1",label:"x"};assert.throws(()=>buildTrajectoryDataset("a3-v1",[x]),/UNTRACEABLE_EVALUATOR/);});
