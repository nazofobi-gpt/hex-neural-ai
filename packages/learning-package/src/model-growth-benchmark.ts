export interface BenchmarkSample {
  readonly id: string;
  readonly baselineQuality: number;
  readonly candidateQuality: number;
  readonly baselineLatencyMs: number;
  readonly candidateLatencyMs: number;
  readonly baselineMemoryMb: number;
  readonly candidateMemoryMb: number;
  readonly baselineCost: number;
  readonly candidateCost: number;
  readonly securityRegression: boolean;
  readonly routingValid: boolean;
}
export interface BenchmarkPolicy {
  readonly minQualityGain: number;
  readonly maxLatencyRatio: number;
  readonly maxMemoryRatio: number;
  readonly maxCostRatio: number;
  readonly minSamples: number;
}
export type ActivationVerdict="PASS"|"FAIL";
export interface BenchmarkVerdict {
  readonly verdict: ActivationVerdict;
  readonly reversible: true;
  readonly active: boolean;
  readonly sampleCount: number;
  readonly meanQualityGain: number;
  readonly p95LatencyRatio: number;
  readonly maxMemoryRatio: number;
  readonly meanCostRatio: number;
  readonly reasons: readonly string[];
}
export interface BenchmarkEvalCase {
  readonly id: string;
  readonly input: string;
}
export interface VersionedBenchmarkEvalSet {
  readonly id: string;
  readonly version: string;
  readonly checksum: string;
  readonly cases: readonly BenchmarkEvalCase[];
}
export interface BenchmarkExecution {
  readonly output: string;
  readonly memoryMb: number;
  readonly cost: number;
  readonly securityRegression: boolean;
  readonly routingValid: boolean;
}
export interface BenchmarkRunner {
  readonly id: string;
  readonly version: string;
  execute(input:string):Promise<BenchmarkExecution>;
}
export type BenchmarkQualityScorer=(testCase:BenchmarkEvalCase,output:string)=>number;
export interface BenchmarkCollectionProvenance {
  readonly schemaVersion:"1";
  readonly collectorVersion:"1";
  readonly evalSet:{readonly id:string;readonly version:string;readonly checksum:string};
  readonly baseline:{readonly id:string;readonly version:string};
  readonly candidate:{readonly id:string;readonly version:string};
  readonly collectedAt:string;
  readonly measurementMethod:"EXECUTED_RUNNERS_MONOTONIC_CLOCK";
}
export interface CollectedBenchmark {
  readonly samples:readonly BenchmarkSample[];
  readonly provenance:BenchmarkCollectionProvenance;
  readonly verdict:BenchmarkVerdict;
}
export interface BenchmarkCollectorOptions {
  readonly now?:()=>number;
  readonly collectedAt?:()=>string;
  readonly maxCases?:number;
}
const mean=(xs:readonly number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
const ratio=(candidate:number,baseline:number)=>baseline>0?candidate/baseline:Number.POSITIVE_INFINITY;
const finiteNonNegative=(name:string,value:number)=>{
  if(!Number.isFinite(value)||value<0)throw new Error("INVALID_"+name.toUpperCase());
  return value;
};
const quality=(value:number)=>{
  if(!Number.isFinite(value)||value<0||value>1)throw new Error("INVALID_QUALITY");
  return value;
};
function validateEvalSet(evalSet:VersionedBenchmarkEvalSet,maxCases:number){
  if(!evalSet.id.trim()||!evalSet.version.trim()||!evalSet.checksum.trim())throw new Error("INVALID_EVAL_SET_IDENTITY");
  if(evalSet.cases.length===0||evalSet.cases.length>maxCases)throw new Error("INVALID_EVAL_SET_SIZE");
  const ids=new Set<string>();
  for(const item of evalSet.cases){
    if(!item.id.trim()||ids.has(item.id))throw new Error("INVALID_EVAL_CASE_ID");
    ids.add(item.id);
  }
}
export function evaluateModelGrowth(samples:readonly BenchmarkSample[],policy:BenchmarkPolicy):BenchmarkVerdict{
  const reasons:string[]=[];
  if(samples.length<policy.minSamples) reasons.push("INSUFFICIENT_SAMPLES");
  if(samples.length===0) return {verdict:"FAIL",reversible:true,active:false,sampleCount:0,meanQualityGain:0,p95LatencyRatio:Number.POSITIVE_INFINITY,maxMemoryRatio:Number.POSITIVE_INFINITY,meanCostRatio:Number.POSITIVE_INFINITY,reasons};
  const gains=samples.map(x=>x.candidateQuality-x.baselineQuality);
  const latency=samples.map(x=>ratio(x.candidateLatencyMs,x.baselineLatencyMs)).sort((a,b)=>a-b);
  const memory=samples.map(x=>ratio(x.candidateMemoryMb,x.baselineMemoryMb));
  const costs=samples.map(x=>ratio(x.candidateCost,x.baselineCost));
  const meanQualityGain=mean(gains);
  const p95LatencyRatio=latency[Math.min(latency.length-1,Math.ceil(latency.length*.95)-1)];
  const maxMemoryRatio=Math.max(...memory);
  const meanCostRatio=mean(costs);
  if(meanQualityGain<policy.minQualityGain) reasons.push("QUALITY_GAIN_BELOW_THRESHOLD");
  if(p95LatencyRatio>policy.maxLatencyRatio) reasons.push("LATENCY_REGRESSION");
  if(maxMemoryRatio>policy.maxMemoryRatio) reasons.push("MEMORY_REGRESSION");
  if(meanCostRatio>policy.maxCostRatio) reasons.push("COST_REGRESSION");
  if(samples.some(x=>x.securityRegression)) reasons.push("SECURITY_REGRESSION");
  if(samples.some(x=>!x.routingValid)) reasons.push("ROUTING_REGRESSION");
  const verdict:ActivationVerdict=reasons.length===0?"PASS":"FAIL";
  return {verdict,reversible:true,active:false,sampleCount:samples.length,meanQualityGain,p95LatencyRatio,maxMemoryRatio,meanCostRatio,reasons};
}
export async function collectModelGrowthBenchmark(
  evalSet:VersionedBenchmarkEvalSet,
  baseline:BenchmarkRunner,
  candidate:BenchmarkRunner,
  score:BenchmarkQualityScorer,
  policy:BenchmarkPolicy,
  options:BenchmarkCollectorOptions={}
):Promise<CollectedBenchmark>{
  const maxCases=options.maxCases??256;
  validateEvalSet(evalSet,maxCases);
  if(!baseline.id.trim()||!baseline.version.trim()||!candidate.id.trim()||!candidate.version.trim())throw new Error("INVALID_RUNNER_IDENTITY");
  const now=options.now??(()=>Date.now());
  const collectedAt=options.collectedAt??(()=>new Date().toISOString());
  const samples:BenchmarkSample[]=[];
  for(const testCase of evalSet.cases){
    const baselineStart=now();
    const baselineResult=await baseline.execute(testCase.input);
    const baselineLatencyMs=finiteNonNegative("baseline_latency_ms",now()-baselineStart);
    const candidateStart=now();
    const candidateResult=await candidate.execute(testCase.input);
    const candidateLatencyMs=finiteNonNegative("candidate_latency_ms",now()-candidateStart);
    const baselineQuality=quality(score(testCase,baselineResult.output));
    const candidateQuality=quality(score(testCase,candidateResult.output));
    samples.push({
      id:testCase.id,
      baselineQuality,
      candidateQuality,
      baselineLatencyMs,
      candidateLatencyMs,
      baselineMemoryMb:finiteNonNegative("baseline_memory_mb",baselineResult.memoryMb),
      candidateMemoryMb:finiteNonNegative("candidate_memory_mb",candidateResult.memoryMb),
      baselineCost:finiteNonNegative("baseline_cost",baselineResult.cost),
      candidateCost:finiteNonNegative("candidate_cost",candidateResult.cost),
      securityRegression:baselineResult.securityRegression||candidateResult.securityRegression,
      routingValid:baselineResult.routingValid&&candidateResult.routingValid
    });
  }
  const provenance:BenchmarkCollectionProvenance={
    schemaVersion:"1",
    collectorVersion:"1",
    evalSet:{id:evalSet.id,version:evalSet.version,checksum:evalSet.checksum},
    baseline:{id:baseline.id,version:baseline.version},
    candidate:{id:candidate.id,version:candidate.version},
    collectedAt:collectedAt(),
    measurementMethod:"EXECUTED_RUNNERS_MONOTONIC_CLOCK"
  };
  return {samples,provenance,verdict:evaluateModelGrowth(samples,policy)};
}
