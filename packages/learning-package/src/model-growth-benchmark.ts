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
const mean=(xs:readonly number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
const ratio=(candidate:number,baseline:number)=>baseline>0?candidate/baseline:Number.POSITIVE_INFINITY;
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
