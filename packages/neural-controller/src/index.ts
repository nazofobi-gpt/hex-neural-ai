export const SUPPORTED_SIZES = [16, 32, 48, 64] as const;
export type CircuitSize = (typeof SUPPORTED_SIZES)[number];
export interface LifConfig { size:CircuitSize; steps:number; seed:number; beta:number; threshold:number; inhibitoryFraction:number; connectionProbability:number; excitatoryWeight:number; inhibitoryWeight:number; maxSpikeRate:number; minSpikeRate:number; delays:number; }
export interface ActivityMetrics { totalSpikes:number; spikeRate:number; activeNeurons:number; runaway:boolean; inactive:boolean; faceActivity:number[]; }
export interface LifResult { spikes:number[][]; membrane:number[]; metrics:ActivityMetrics; }
export const defaultLifConfig=(size:CircuitSize=32):LifConfig=>({size,steps:24,seed:1,beta:.9,threshold:1,inhibitoryFraction:.2,connectionProbability:.15,excitatoryWeight:.22,inhibitoryWeight:.28,maxSpikeRate:.75,minSpikeRate:.001,delays:2});
function rng(seed:number){let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);}
export function simulateLif(input:number[], cfg:LifConfig):LifResult {
 if(!SUPPORTED_SIZES.includes(cfg.size)||cfg.steps<1||cfg.beta<0||cfg.beta>=1||cfg.threshold<=0||cfg.delays<1) throw new Error("INVALID_LIF_CONFIG");
 const rand=rng(cfg.seed), n=cfg.size, inhibitoryStart=Math.floor(n*(1-cfg.inhibitoryFraction));
 const edges:{from:number;to:number;w:number;delay:number}[]=[];
 for(let i=0;i<n;i++) for(let j=0;j<n;j++) if(i!==j&&rand()<cfg.connectionProbability) edges.push({from:i,to:j,w:i>=inhibitoryStart?-cfg.inhibitoryWeight:cfg.excitatoryWeight,delay:1+Math.floor(rand()*cfg.delays)});
 const mem=Array(n).fill(0), history=Array.from({length:cfg.steps+cfg.delays+1},()=>Array(n).fill(0)), spikes:number[][]=[];
 for(let t=0;t<cfg.steps;t++){const current=Array(n).fill(0); for(const e of edges){const at=t-e.delay;if(at>=0) current[e.to]+=history[at][e.from]*e.w;} for(let i=0;i<n;i++){mem[i]=cfg.beta*mem[i]+current[i]+(input[t%Math.max(1,input.length)]??0); if(mem[i]>=cfg.threshold){history[t][i]=1;mem[i]-=cfg.threshold;}} spikes.push([...history[t]]);}
 const totalSpikes=spikes.flat().reduce((a,b)=>a+b,0), spikeRate=totalSpikes/(n*cfg.steps), activeNeurons=spikes[0].map((_,i)=>spikes.some(s=>s[i]>0)).filter(Boolean).length;
 const faceActivity=Array.from({length:6},(_,f)=>{let c=0,d=0;for(let i=f;i<n;i+=6){d+=cfg.steps;for(const s of spikes)c+=s[i];}return d?c/d:0;});
 return {spikes,membrane:mem,metrics:{totalSpikes,spikeRate,activeNeurons,runaway:spikeRate>cfg.maxSpikeRate,inactive:spikeRate<cfg.minSpikeRate,faceActivity}};
}
export interface ControllerDecision { enabled:boolean; selectedIndex:number; scores:number[]; metrics:ActivityMetrics|null; }
export function chooseRoute(baselineScores:number[], input:number[], cfg:LifConfig, enabled=true):ControllerDecision {
 if(!enabled||baselineScores.length===0) return {enabled:false,selectedIndex:baselineScores.indexOf(Math.max(...baselineScores)),scores:[...baselineScores],metrics:null};
 const result=simulateLif(input,cfg); if(result.metrics.runaway||result.metrics.inactive) return {enabled:false,selectedIndex:baselineScores.indexOf(Math.max(...baselineScores)),scores:[...baselineScores],metrics:result.metrics};
 const scores=baselineScores.map((v,i)=>v+(result.metrics.faceActivity[i%6]??0)); return {enabled:true,selectedIndex:scores.indexOf(Math.max(...scores)),scores,metrics:result.metrics};
}
export interface ComparatorSample { baselineQuality:number; controllerQuality:number; baselineLatencyMs:number; controllerLatencyMs:number; baselineCost:number; controllerCost:number; }
export function compareController(s:ComparatorSample){return {qualityDelta:s.controllerQuality-s.baselineQuality,latencyDeltaMs:s.controllerLatencyMs-s.baselineLatencyMs,costDelta:s.controllerCost-s.baselineCost};}
