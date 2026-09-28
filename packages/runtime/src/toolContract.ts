export type ProtocolEra = "legacy-2025" | "modern-2026";
export type SideEffectClass = "read" | "write";
export interface ImportedTool { name:string; inputSchema:string; outputSchema:string; permission:string; sideEffect:SideEffectClass; protocol?:{ era?:ProtocolEra; capabilities?:readonly string[]; authIssuer?:string; authScopes?:readonly string[]; cache?:{ttlMs:number;cacheScope:"private"|"public"} } }
export interface ToolContract { name:string; inputSchema:string; outputSchema:string; permission:string; sideEffect:SideEffectClass; protocolEra:ProtocolEra; protocolVersion:string; capabilities:readonly string[]; auth:{issuer:string|null;scopes:readonly string[]}; cache:{ttlMs:number;cacheScope:"private"|"public"}; transport:{lifecycle:"initialize"|"server/discover";requestModel:"session"|"stateless";multiRoundTrip:"server-request"|"input_required";headerRouting:boolean} }
export type CompileToolResult={ok:true;contract:ToolContract}|{ok:false;code:"UNSUPPORTED_ERA"|"UNSUPPORTED_METHOD"|"PERMISSION_DENIED"|"SIDE_EFFECT_DENIED"|"AUTH_MISMATCH";quarantined:true};
const MODERN_CAPS=new Set(["server/discover","requestState","input_required","mcp-param-headers","list-cache","auth-issuer-scope"]);
export function compileImportedTool(tool:ImportedTool,policy:{allowedPermissions:readonly string[];shadow:boolean;supportedModernCapabilities?:readonly string[]}):CompileToolResult{
 const era=tool.protocol?.era??"legacy-2025";
 if(era!=="legacy-2025"&&era!=="modern-2026") return {ok:false,code:"UNSUPPORTED_ERA",quarantined:true};
 if(!policy.allowedPermissions.includes(tool.permission)) return {ok:false,code:"PERMISSION_DENIED",quarantined:true};
 if(tool.sideEffect==="write"&&!policy.shadow) return {ok:false,code:"SIDE_EFFECT_DENIED",quarantined:true};
 const capabilities=[...(tool.protocol?.capabilities??[])].sort();
 if(era==="modern-2026"){const supported=new Set(policy.supportedModernCapabilities??[...MODERN_CAPS]);if(capabilities.some(c=>!MODERN_CAPS.has(c)||!supported.has(c)))return {ok:false,code:"UNSUPPORTED_METHOD",quarantined:true};if(Boolean(tool.protocol?.authIssuer)!==Boolean(tool.protocol?.authScopes?.length))return {ok:false,code:"AUTH_MISMATCH",quarantined:true};}
 return {ok:true,contract:{name:tool.name,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,permission:tool.permission,sideEffect:tool.sideEffect,protocolEra:era,protocolVersion:era==="modern-2026"?"2026-07-28":"2025-11-25",capabilities,auth:{issuer:tool.protocol?.authIssuer??null,scopes:[...(tool.protocol?.authScopes??[])].sort()},cache:tool.protocol?.cache??{ttlMs:0,cacheScope:"private"},transport:era==="modern-2026"?{lifecycle:"server/discover",requestModel:"stateless",multiRoundTrip:"input_required",headerRouting:true}:{lifecycle:"initialize",requestModel:"session",multiRoundTrip:"server-request",headerRouting:false}}};
}
export function sameToolSemantics(a:ToolContract,b:ToolContract):boolean{return a.name===b.name&&a.inputSchema===b.inputSchema&&a.outputSchema===b.outputSchema&&a.permission===b.permission&&a.sideEffect===b.sideEffect;}
