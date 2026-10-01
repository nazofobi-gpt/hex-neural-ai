export type LearningScope="SESSION"|"PROJECT"|"USER";
export type Capability="network"|"tool"|"billing"|"permission"|"secret";
export interface Principal { id:string; roles:readonly string[] }
export interface Policy { roleCapabilities:Readonly<Record<string,readonly Capability[]>>; networkAllowlist:readonly string[]; maxCostUsd:number; maxRequests:number }
export interface Provenance { source:string; trusted:boolean; graphVersion:string; neuralVersion:string; modelVersion:string; runId:string }
export interface AuditEvent { action:string; principalId:string; allowed:boolean; reason:string; provenance:Provenance }
export class TrustPlatform {
  readonly audit:AuditEvent[]=[];
  private learning=new Map<LearningScope,unknown>();
  constructor(private readonly policy:Policy){}
  authorize(p:Principal, capability:Capability, prov:Provenance):boolean {
    const granted=new Set(p.roles.flatMap(r=>[...(this.policy.roleCapabilities[r]??[])]));
    const allowed=prov.trusted && granted.has(capability);
    this.audit.push({action:`capability:${capability}`,principalId:p.id,allowed,reason:allowed?"rbac":"fail-closed",provenance:prov});
    return allowed;
  }
  authorizeNetwork(p:Principal,url:string,prov:Provenance):boolean {
    let host=""; try { host=new URL(url).hostname } catch {}
    const allowed=this.authorize(p,"network",prov) && this.policy.networkAllowlist.includes(host);
    if(!allowed) this.audit.push({action:"network",principalId:p.id,allowed:false,reason:"host-not-allowed",provenance:prov});
    return allowed;
  }
  enforceBudget(requests:number,costUsd:number):boolean { return requests<=this.policy.maxRequests && costUsd<=this.policy.maxCostUsd }
  setLearning(scope:LearningScope,value:unknown):void { this.learning.set(scope,structuredClone(value)) }
  inspectLearning(scope:LearningScope):unknown { return structuredClone(this.learning.get(scope)) }
  resetLearning(scope:LearningScope):void { this.learning.delete(scope) }
  static redact(input:string):string { return input.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,"$1=[REDACTED]") }
  static artifactSafe(input:string):boolean { return !/(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/.test(input) }
}
export function immutableSecurityFields(update:Record<string,unknown>):boolean {
  return !["permission","billing","access","secret"].some(k=>Object.prototype.hasOwnProperty.call(update,k));
}
