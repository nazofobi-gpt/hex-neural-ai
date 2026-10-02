import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { chooseRoute, defaultLifConfig } from "../packages/neural-controller/dist/index.js";

function rng(seed){let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);}
function mean(a){return a.reduce((x,y)=>x+y,0)/a.length}
function ci95Bernoulli(p,n){return 1.96*Math.sqrt(Math.max(0,p*(1-p)/n))}
function run(n,seed){
 const r=rng(seed), bandit=Array(6).fill(0), out={det:{ok:0,lat:[],edits:0,cost:0},bandit:{ok:0,lat:[],edits:0,cost:0},snn:{ok:0,lat:[],edits:0,cost:0}};
 const cfg={...defaultLifConfig(32),seed};
 for(let k=0;k<n;k++){
  const target=Math.floor(r()*6); const base=Array.from({length:6},(_,i)=>0.45+r()*.1+(i===target?.0:0));
  let t=performance.now(); const d=base.indexOf(Math.max(...base)); out.det.lat.push(performance.now()-t); out.det.ok+=d===target?1:0; out.det.edits+=d===target?0:1; out.det.cost+=1;
  t=performance.now(); const bs=base.map((v,i)=>v+bandit[i]); const b=bs.indexOf(Math.max(...bs)); out.bandit.lat.push(performance.now()-t); out.bandit.ok+=b===target?1:0; out.bandit.edits+=b===target?0:1; out.bandit.cost+=1.15; bandit[target]=Math.min(.25,bandit[target]+.002); bandit[b]=Math.max(-.25,bandit[b]+(b===target?.001:-.001));
  t=performance.now(); const s=chooseRoute(base,Array.from({length:24},()=>.04+r()*.08),cfg,true); out.snn.lat.push(performance.now()-t); out.snn.ok+=s.selectedIndex===target?1:0; out.snn.edits+=s.selectedIndex===target?0:1; out.snn.cost+=32*24;
 }
 return Object.fromEntries(Object.entries(out).map(([name,x])=>[name,{completion:x.ok/n,acceptance:x.ok/n,editLoad:x.edits/n,latencyMs:mean(x.lat),costProxy:x.cost/n,ci95:ci95Bernoulli(x.ok/n,n)}]));
}
const visible=run(2000,204), stored=run(10000,1204);
const evidence={
 task:"G-204", generatedAt:new Date().toISOString(), synthetic:true,
 caveat:"Synthetic deterministic routing benchmark. costProxy is relative operation/load proxy, not currency. Results do not establish production superiority.",
 hypotheses:{
  H1:{method:"2k visible synthetic routing trials",dataset:"seeded synthetic 6-route contexts",baseline:"deterministic argmax",metric:"completion/acceptance/edit-load/latency"},
  H2:{method:"10k stored synthetic routing trials",dataset:"seeded synthetic 6-route contexts",baseline:"deterministic argmax",metric:"completion/acceptance/edit-load/latency"},
  H3:{method:"controller comparison",dataset:"same seeded contexts",baseline:"deterministic vs bounded contextual bandit vs LIF SNN",metric:"quality, latency, relative cost proxy"},
  H4:{method:"uncertainty",dataset:"same trials",baseline:"normal-approx Bernoulli interval",metric:"95% half-width; synthetic-only limitation"}
 },
 visible,stored,
 decision:"Do not promote SNN to critical-path default unless it improves acceptance/completion without material latency/cost regression; otherwise deterministic baseline remains default and SNN stays optional R&D."
};
writeFileSync("g204-evidence.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
if(Object.values(visible).some(x=>!Number.isFinite(x.latencyMs))||Object.values(stored).some(x=>!Number.isFinite(x.latencyMs))) process.exit(1);
