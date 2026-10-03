export type Scope="SESSION"|"PROJECT"|"USER";
export type Signal="positive"|"negative"|"undo"|"regenerate";
export interface UserEvent{signal:Signal;scope:Scope;scopeId:string;action:string;ts:number}
export interface Checkpoint{version:number;graphVersion:string;seed:number;weights:Record<string,number>}
export interface Config{learningRate:number;maxAbs:number;decay:number;pruneBelow:number;reward:Record<Signal,number>}
const DEFAULT:Config={learningRate:.1,maxAbs:1,decay:.98,pruneBelow:.001,reward:{positive:1,negative:-1,undo:-.75,regenerate:-.5}};
const key=(s:Scope,id:string,a:string)=>s+":"+id+":"+a;
export class BoundedLearner{
 private weights=new Map<string,number>(); private version=0;
 constructor(private graphVersion:string,private seed:number,private cfg:Config=DEFAULT){}
 observe(e:UserEvent){const k=key(e.scope,e.scopeId,e.action),old=this.weights.get(k)??0;
  const next=Math.max(-this.cfg.maxAbs,Math.min(this.cfg.maxAbs,(old+this.cfg.learningRate*this.cfg.reward[e.signal])*this.cfg.decay));
  if(Math.abs(next)<this.cfg.pruneBelow)this.weights.delete(k);else this.weights.set(k,next); this.version++;
  return {key:k,before:old,after:this.weights.get(k)??0,reward:this.cfg.reward[e.signal],version:this.version};}
 score(scope:Scope,scopeId:string,action:string){return this.weights.get(key(scope,scopeId,action))??0}
 checkpoint():Checkpoint{return{version:this.version,graphVersion:this.graphVersion,seed:this.seed,weights:Object.fromEntries(this.weights)}}
 restore(c:Checkpoint){if(c.graphVersion!==this.graphVersion||c.seed!==this.seed)throw new Error("checkpoint identity mismatch");
  this.version=c.version;this.weights=new Map(Object.entries(c.weights).filter(([,v])=>Math.abs(v)<=this.cfg.maxAbs));}
 reset(scope?:Scope,scopeId?:string){if(!scope){this.weights.clear();this.version++;return}for(const k of [...this.weights.keys()])if(k.startsWith(scope+":"+scopeId+":"))this.weights.delete(k);this.version++}
 forget(scope:Scope,scopeId:string){this.reset(scope,scopeId)}
}
export const defaultConfig=():Config=>({...DEFAULT,reward:{...DEFAULT.reward}});
