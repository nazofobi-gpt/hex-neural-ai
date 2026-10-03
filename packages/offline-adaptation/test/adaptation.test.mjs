import test from "node:test";
import assert from "node:assert/strict";
import {trainOfflineAdapter,rollbackAdapter} from "../dist/index.js";
const ex=(id,x,label)=>({id,features:[x],label,permission:"ADAPTATION_ALLOWED"});
const baseInput=()=>({
  baseVersion:"base-v1",datasetVersion:"tiny-v1",requestedEpochs:20,baselineWeights:[0],
  train:[ex("t1",1,1),ex("t2",2,2)],holdout:[ex("h1",3,3)],regression:[ex("r1",0,0)],
  budget:{maxEpochs:20,maxExamples:10,maxParameters:4,learningRate:.05},
  minHoldoutImprovement:.1,maxRegressionDelta:.001
});
test("tiny offline fixture improves held-out metric deterministically",()=>{
  const a=trainOfflineAdapter(baseInput()),b=trainOfflineAdapter(baseInput());
  assert.equal(a.accepted,true);assert.ok(a.holdoutImprovement>.1);assert.deepEqual(a,b);
  assert.deepEqual(a.cost,{epochs:20,examplesSeen:40,parameterUpdates:40});
  assert.match(a.adapterVersion,/^adapter-[0-9a-f]{8}$/);
});
test("train and holdout leakage fails closed by id or content",()=>{
  const byId=baseInput();byId.holdout=[ex("t1",3,3)];assert.throws(()=>trainOfflineAdapter(byId),/HOLDOUT_LEAKAGE/);
  const byContent=baseInput();byContent.holdout=[ex("other",2,2)];assert.throws(()=>trainOfflineAdapter(byContent),/HOLDOUT_LEAKAGE/);
});
test("forgetting regression rejects candidate and preserves baseline",()=>{
  const input=baseInput();input.regression=[ex("r1",1,0)];input.maxRegressionDelta=0;
  const report=trainOfflineAdapter(input);assert.equal(report.accepted,false);assert.equal(report.rejectionReason,"FORGETTING_REGRESSION");
  assert.deepEqual(report.activeWeights,input.baselineWeights);assert.deepEqual(rollbackAdapter(report,input.baselineWeights),input.baselineWeights);
});
test("budget caps block epochs examples and parameters",()=>{
  const epochs=baseInput();epochs.requestedEpochs=21;assert.throws(()=>trainOfflineAdapter(epochs),/EPOCH_BUDGET_EXCEEDED/);
  const examples=baseInput();examples.budget.maxExamples=2;assert.throws(()=>trainOfflineAdapter(examples),/EXAMPLE_BUDGET_EXCEEDED/);
  const params=baseInput();params.baselineWeights=[0,0,0,0,0];assert.throws(()=>trainOfflineAdapter(params),/PARAMETER_BUDGET_EXCEEDED/);
});
test("non-authorized examples cannot enter offline adaptation",()=>{
  const input=baseInput();input.train=[{...input.train[0],permission:"HARD_POLICY"}];
  assert.throws(()=>trainOfflineAdapter(input),/ADAPTATION_PERMISSION_REQUIRED/);
});
test("training is pure with respect to caller-owned input",()=>{
  const input=baseInput();const before=JSON.parse(JSON.stringify(input));trainOfflineAdapter(input);assert.deepEqual(input,before);
});
