import type { ModelCapsule } from "./model-capsule.js";
export type ExecutionMode="native"|"wrapper"|"external";
export type RuntimeCode="CAPSULE_NOT_VERIFIED"|"RESOURCE_EXCEEDED"|"TIMEOUT"|"PROVIDER_ERROR"|"VERSION_MISMATCH";
export type Outcome={ok:true;mode:ExecutionMode;capsuleId:string;sourceVersion:string;output:string}|{ok:false;code:RuntimeCode;message:string;retryable:boolean};
export interface Executor{readonly mode:ExecutionMode;health():Promise<boolean>;execute(input:string,signal:AbortSignal):Promise<string>}
export interface Checkpoint{schemaVersion:"1";capsuleId:string;sourceVersion:string;mode:ExecutionMode;memoryMb:number;timeoutMs:number}
export interface Store{load(id:string):Promise<Checkpoint|undefined>;save(v:Checkpoint):Promise<void>}
export class MemoryStore implements Store{private m=new Map<string,Checkpoint>();async load(id:string){return this.m.get(id)}async save(v:Checkpoint){this.m.set(v.capsuleId,structuredClone(v))}}
const fail=(code:RuntimeCode,message:string,retryable=false):Outcome=>({ok:false,code,message,retryable});
export class ModelRuntimeLoader{
 private b=new Map<string,{capsule:ModelCapsule;executor:Executor;checkpoint:Checkpoint}>();
 constructor(private store:Store,private availableMemoryMb:number){}
 async bind(capsule:ModelCapsule,executor:Executor,timeoutMs=1000):Promise<Outcome>{
  if(capsule.status!=="VERIFIED")return fail("CAPSULE_NOT_VERIFIED",capsule.status);
  const memoryMb=capsule.manifest.resources.memoryMb;
  if(memoryMb<=0||memoryMb>this.availableMemoryMb)return fail("RESOURCE_EXCEEDED","memory");
  if(timeoutMs<=0)return fail("TIMEOUT","timeout");
  if(!(await executor.health()))return fail("PROVIDER_ERROR","health",true);
  const old=await this.store.load(capsule.capsuleId);
  if(old&&old.sourceVersion!==capsule.manifest.sourceVersion)return fail("VERSION_MISMATCH","version drift");
  const checkpoint:Checkpoint={schemaVersion:"1",capsuleId:capsule.capsuleId,sourceVersion:capsule.manifest.sourceVersion,mode:executor.mode,memoryMb,timeoutMs};
  await this.store.save(checkpoint);this.b.set(capsule.capsuleId,{capsule,executor,checkpoint});
  return{ok:true,mode:executor.mode,capsuleId:capsule.capsuleId,sourceVersion:checkpoint.sourceVersion,output:"BOUND"};
 }
 async execute(id:string,input:string):Promise<Outcome>{
  const x=this.b.get(id);if(!x)return fail("PROVIDER_ERROR","not bound");
  const persisted=await this.store.load(id);if(!persisted||persisted.sourceVersion!==x.checkpoint.sourceVersion)return fail("VERSION_MISMATCH","checkpoint drift");
  const c=new AbortController(),t=setTimeout(()=>c.abort(),x.checkpoint.timeoutMs);
  try{const output=await x.executor.execute(input,c.signal);return{ok:true,mode:x.executor.mode,capsuleId:id,sourceVersion:x.checkpoint.sourceVersion,output}}
  catch(e){return c.signal.aborted?fail("TIMEOUT","timeout",true):fail("PROVIDER_ERROR",e instanceof Error?e.message:"error",true)}
  finally{clearTimeout(t)}
 }
 async restore(capsule:ModelCapsule,executors:Record<ExecutionMode,Executor>):Promise<Outcome>{
  const p=await this.store.load(capsule.capsuleId);if(!p)return fail("PROVIDER_ERROR","no checkpoint");
  if(p.sourceVersion!==capsule.manifest.sourceVersion)return fail("VERSION_MISMATCH","restart drift");
  return this.bind(capsule,executors[p.mode],p.timeoutMs);
 }
}