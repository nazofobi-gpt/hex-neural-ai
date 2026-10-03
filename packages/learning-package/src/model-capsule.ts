export type ModelCapsuleStatus = "VERIFIED" | "QUARANTINED" | "BLOCKED_SOURCE";
export interface ModelCapsuleManifest {
  schemaVersion:"1"; modelId:string; sourceVersion:string; sourceUri:string;
  usageRights:{verified:boolean;basis:string};
  artifacts:{weights:{format:"safetensors";checksum:{algorithm:"sha256";value:string}};config:string;tokenizer?:string;processor?:string};
  architecture:string; dtype:string; quantization?:string; limits:{contextTokens?:number;inputShape?:string};
  resources:{memoryMb:number;accelerator?:string}; eval:{suite:string;version:string}; requiresRemoteCode:boolean;
}
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? ReadonlyArray<DeepReadonly<U>> :
  T extends object ? {readonly [K in keyof T]: DeepReadonly<T[K]>} : T;
export interface ModelCapsule { schemaVersion:"1"; capsuleId:string; manifest:DeepReadonly<ModelCapsuleManifest>; status:ModelCapsuleStatus; quarantineReason?:string; }
const encoder=new TextEncoder();
async function digestHex(bytes:string|Uint8Array){const input=typeof bytes==="string"?encoder.encode(bytes):bytes;const buffer=new ArrayBuffer(input.byteLength);new Uint8Array(buffer).set(input);const digest=await crypto.subtle.digest("SHA-256",buffer);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");}
function deepFreeze<T>(value:T):DeepReadonly<T>{
 if(value!==null&&typeof value==="object"&&!Object.isFrozen(value)){
  const record=value as unknown as Record<PropertyKey,unknown>;
  for(const key of Reflect.ownKeys(record))deepFreeze(record[key]);
  Object.freeze(value);
 }
 return value as DeepReadonly<T>;
}
function capsule(manifest:ModelCapsuleManifest,status:ModelCapsuleStatus,quarantineReason?:string):ModelCapsule{
 const immutableManifest=deepFreeze(structuredClone(manifest));
 return deepFreeze({schemaVersion:"1" as const,capsuleId:manifest.modelId+"@"+manifest.sourceVersion,manifest:immutableManifest,status,...(quarantineReason?{quarantineReason}:{})});
}
function reject(manifest:ModelCapsuleManifest,reason:string):ModelCapsule{return capsule(manifest,reason==="USAGE_RIGHTS_UNVERIFIED"?"BLOCKED_SOURCE":"QUARANTINED",reason);}
export async function intakeModelCapsule(manifest:ModelCapsuleManifest,canonicalWeights:string|Uint8Array):Promise<ModelCapsule>{
 if(!manifest.modelId.trim()||!manifest.sourceVersion.trim()||!manifest.sourceUri.trim())return reject(manifest,"MISSING_SOURCE_IDENTITY");
 if(!manifest.usageRights.verified||!manifest.usageRights.basis.trim())return reject(manifest,"USAGE_RIGHTS_UNVERIFIED");
 if(manifest.requiresRemoteCode)return reject(manifest,"REMOTE_CODE_DENIED");
 if(manifest.artifacts.weights.format!=="safetensors")return reject(manifest,"UNSAFE_SERIALIZATION");
 const expected=manifest.artifacts.weights.checksum;
 if(expected.algorithm!=="sha256"||!/^[a-f0-9]{64}$/i.test(expected.value))return reject(manifest,"INVALID_CHECKSUM");
 if(!manifest.architecture.trim()||!manifest.dtype.trim()||!manifest.artifacts.config.trim()||manifest.resources.memoryMb<=0||!manifest.eval.suite.trim()||!manifest.eval.version.trim())return reject(manifest,"INCOMPLETE_MANIFEST");
 const actual=await digestHex(canonicalWeights);if(actual.toLowerCase()!==expected.value.toLowerCase())return reject(manifest,"CHECKSUM_MISMATCH");
 return capsule(manifest,"VERIFIED");
}
