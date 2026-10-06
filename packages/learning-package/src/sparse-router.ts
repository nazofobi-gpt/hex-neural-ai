import type { ModelCapsule } from "./model-capsule.js";
import type { ExecutionMode } from "./model-runtime.js";

export type CapabilityId = string;
export interface ExpertBinding {
  readonly expertId: string;
  readonly capsule: ModelCapsule;
  readonly mode: ExecutionMode;
  readonly capabilities: readonly CapabilityId[];
  readonly priority: number;
  readonly estimatedCost: number;
}
export interface RouteRequest {
  readonly capability: CapabilityId;
  readonly confidence: number;
  readonly hardAllowedExpertIds?: readonly string[];
}
export interface RouteDecision {
  readonly selectedExpertIds: readonly string[];
  readonly fallback: boolean;
  readonly reason: "TOP_K"|"LOW_CONFIDENCE"|"ROUTE_COLLAPSE";
}
export interface RoutingMetrics {
  readonly callsByExpert: Readonly<Record<string,number>>;
  readonly deadExpertIds: readonly string[];
  readonly collapsed: boolean;
}
export interface BridgeClusterRoute {
  readonly bridgeClusterId: string;
  readonly expertId: string;
  readonly capability: CapabilityId;
}
export class SparseCapabilityRouter {
  private readonly calls = new Map<string,number>();
  constructor(
    private readonly registry: readonly ExpertBinding[],
    private readonly fallbackExpertId: string,
    private readonly minConfidence = 0.5
  ) {
    const ids = new Set(registry.map(x=>x.expertId));
    if(ids.size!==registry.length) throw new Error("DUPLICATE_EXPERT");
    if(!ids.has(fallbackExpertId)) throw new Error("MISSING_FALLBACK");
    for(const x of registry){
      if(x.capsule.status!=="VERIFIED") throw new Error("UNVERIFIED_EXPERT");
      if(!Object.isFrozen(x.capsule)||!Object.isFrozen(x.capsule.manifest)) throw new Error("EXPERT_NOT_FROZEN");
    }
  }
  route(request:RouteRequest,topK=1):RouteDecision {
    if(topK<1) throw new Error("INVALID_TOP_K");
    const allowed=request.hardAllowedExpertIds?new Set(request.hardAllowedExpertIds):undefined;
    const candidates=this.registry.filter(x=>x.capabilities.includes(request.capability)&&(!allowed||allowed.has(x.expertId)));
    if(request.confidence<this.minConfidence||candidates.length===0){
      if(allowed&&!allowed.has(this.fallbackExpertId)) return {selectedExpertIds:[],fallback:true,reason:"ROUTE_COLLAPSE"};
      this.bump(this.fallbackExpertId);
      return {selectedExpertIds:[this.fallbackExpertId],fallback:true,reason:request.confidence<this.minConfidence?"LOW_CONFIDENCE":"ROUTE_COLLAPSE"};
    }
    const ranked=[...candidates].sort((a,b)=>{
      const load=(this.calls.get(a.expertId)??0)-(this.calls.get(b.expertId)??0);
      return load||b.priority-a.priority||a.estimatedCost-b.estimatedCost||a.expertId.localeCompare(b.expertId);
    }).slice(0,Math.min(topK,candidates.length));
    for(const x of ranked)this.bump(x.expertId);
    return {selectedExpertIds:ranked.map(x=>x.expertId),fallback:false,reason:"TOP_K"};
  }
  bridgeRoutes(request:RouteRequest,bridgeClusterId:string,topK=1):readonly BridgeClusterRoute[]{
    return this.route(request,topK).selectedExpertIds.map(expertId=>({bridgeClusterId,expertId,capability:request.capability}));
  }
  metrics():RoutingMetrics{
    const callsByExpert=Object.fromEntries(this.registry.map(x=>[x.expertId,this.calls.get(x.expertId)??0]));
    const values=Object.values(callsByExpert);
    return {callsByExpert,deadExpertIds:Object.entries(callsByExpert).filter(([,n])=>n===0).map(([id])=>id),collapsed:values.length>1&&Math.max(...values)>0&&values.filter(n=>n>0).length===1};
  }
  private bump(id:string){this.calls.set(id,(this.calls.get(id)??0)+1)}
}
