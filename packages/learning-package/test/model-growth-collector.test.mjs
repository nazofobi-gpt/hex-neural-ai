import assert from "node:assert/strict";
import test from "node:test";
import {collectModelGrowthBenchmark} from "../dist/model-growth-benchmark.js";

const policy={minQualityGain:.05,maxLatencyRatio:1.25,maxMemoryRatio:1.2,maxCostRatio:1.15,minSamples:4};

test("collector executes baseline and candidate and records provenance",async()=>{
  const calls=[];
  const make=(id,version,q,memory,cost)=>({id,version,async execute(input){calls.push(id+":"+input);return{output:String(q),memoryMb:memory,cost,securityRegression:false,routingValid:true}}});
  const evalSet={id:"m3-core",version:"1",checksum:"fixture-v1",cases:["a","b","c","d"].map(id=>({id,input:"p-"+id}))};
  const ticks=[0,100,100,210,210,310,310,420,420,520,520,630,630,730,730,840];let i=0;
  const receipt=await collectModelGrowthBenchmark(evalSet,make("base","v1",.7,100,1),make("cand","v2",.8,110,1.05),(_c,o)=>Number(o),policy,{now:()=>ticks[i++],collectedAt:()=>"2026-10-07T12:00:00Z"});
  assert.equal(calls.length,8);
  assert.equal(receipt.samples.length,4);
  assert.equal(receipt.samples[0].baselineLatencyMs,100);
  assert.equal(receipt.samples[0].candidateLatencyMs,110);
  assert.equal(receipt.provenance.evalSet.version,"1");
  assert.equal(receipt.provenance.baseline.version,"v1");
  assert.equal(receipt.provenance.candidate.version,"v2");
  assert.equal(receipt.verdict.verdict,"PASS");
  assert.equal(receipt.verdict.active,false);
});

test("collector rejects unversioned evidence",async()=>{
  const r={id:"r",version:"1",async execute(){return{output:"1",memoryMb:1,cost:1,securityRegression:false,routingValid:true}}};
  await assert.rejects(()=>collectModelGrowthBenchmark({id:"",version:"",checksum:"",cases:[{id:"a",input:"x"}]},r,r,()=>1,policy),/INVALID_EVAL_SET_IDENTITY/);
});
