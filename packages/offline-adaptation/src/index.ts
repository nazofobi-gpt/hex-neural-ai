export interface AdaptationExample {
  id: string;
  features: readonly number[];
  label: number;
  permission: "ADAPTATION_ALLOWED";
}
export interface AdaptationBudget {
  maxEpochs: number;
  maxExamples: number;
  maxParameters: number;
  learningRate: number;
}
export interface AdaptationInput {
  baseVersion: string;
  datasetVersion: string;
  requestedEpochs: number;
  baselineWeights: readonly number[];
  train: readonly AdaptationExample[];
  holdout: readonly AdaptationExample[];
  regression: readonly AdaptationExample[];
  budget: AdaptationBudget;
  minHoldoutImprovement: number;
  maxRegressionDelta: number;
}
export interface Evaluation {
  meanSquaredError: number;
  examples: number;
}
export interface AdaptationReport {
  adapterVersion: string;
  baseHash: string;
  datasetHash: string;
  accepted: boolean;
  rejectionReason: "NO_MEASURED_BENEFIT" | "FORGETTING_REGRESSION" | null;
  baselineHoldout: Evaluation;
  adaptedHoldout: Evaluation;
  baselineRegression: Evaluation;
  adaptedRegression: Evaluation;
  holdoutImprovement: number;
  regressionDelta: number;
  cost: { epochs: number; examplesSeen: number; parameterUpdates: number };
  candidateWeights: readonly number[];
  activeWeights: readonly number[];
}
const stableHash=(value: unknown):string=>{
  const text=JSON.stringify(value);
  let hash=2166136261;
  for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(16).padStart(8,"0");
};
const fingerprint=(example:AdaptationExample)=>JSON.stringify([example.features,example.label]);
const validateExamples=(name:string,examples:readonly AdaptationExample[],dimension:number)=>{
  if(examples.length===0) throw new Error(name+"_REQUIRED");
  for(const example of examples){
    if(!example.id||example.permission!=="ADAPTATION_ALLOWED") throw new Error("ADAPTATION_PERMISSION_REQUIRED");
    if(example.features.length!==dimension||example.features.some(v=>!Number.isFinite(v))||!Number.isFinite(example.label)) throw new Error("INVALID_EXAMPLE");
  }
};
const predict=(weights:readonly number[],features:readonly number[])=>weights.reduce((sum,w,index)=>sum+w*features[index],0);
export const evaluate=(weights:readonly number[],examples:readonly AdaptationExample[]):Evaluation=>({
  meanSquaredError:examples.reduce((sum,example)=>{const error=predict(weights,example.features)-example.label;return sum+error*error;},0)/examples.length,
  examples:examples.length
});
export function trainOfflineAdapter(input:AdaptationInput):AdaptationReport {
  const {budget}=input;
  if(!input.baseVersion||!input.datasetVersion) throw new Error("VERSION_REQUIRED");
  if(input.baselineWeights.length===0||input.baselineWeights.length>budget.maxParameters) throw new Error("PARAMETER_BUDGET_EXCEEDED");
  if(input.requestedEpochs<1||input.requestedEpochs>budget.maxEpochs) throw new Error("EPOCH_BUDGET_EXCEEDED");
  const totalExamples=input.train.length+input.holdout.length+input.regression.length;
  if(totalExamples>budget.maxExamples) throw new Error("EXAMPLE_BUDGET_EXCEEDED");
  if(!(budget.learningRate>0&&budget.learningRate<=1)) throw new Error("INVALID_LEARNING_RATE");
  const dimension=input.baselineWeights.length;
  validateExamples("TRAIN",input.train,dimension);
  validateExamples("HOLDOUT",input.holdout,dimension);
  validateExamples("REGRESSION",input.regression,dimension);
  const trainIds=new Set(input.train.map(example=>example.id));
  const trainContent=new Set(input.train.map(fingerprint));
  if(input.holdout.some(example=>trainIds.has(example.id)||trainContent.has(fingerprint(example)))) throw new Error("HOLDOUT_LEAKAGE");
  const weights=[...input.baselineWeights];
  let parameterUpdates=0;
  for(let epoch=0;epoch<input.requestedEpochs;epoch++){
    for(const example of input.train){
      const error=predict(weights,example.features)-example.label;
      for(let index=0;index<weights.length;index++){weights[index]-=budget.learningRate*2*error*example.features[index];parameterUpdates++;}
    }
  }
  const baselineHoldout=evaluate(input.baselineWeights,input.holdout);
  const adaptedHoldout=evaluate(weights,input.holdout);
  const baselineRegression=evaluate(input.baselineWeights,input.regression);
  const adaptedRegression=evaluate(weights,input.regression);
  const holdoutImprovement=baselineHoldout.meanSquaredError-adaptedHoldout.meanSquaredError;
  const regressionDelta=adaptedRegression.meanSquaredError-baselineRegression.meanSquaredError;
  const rejectionReason=holdoutImprovement<input.minHoldoutImprovement?"NO_MEASURED_BENEFIT":regressionDelta>input.maxRegressionDelta?"FORGETTING_REGRESSION":null;
  const accepted=rejectionReason===null;
  const baseHash=stableHash([input.baseVersion,input.baselineWeights]);
  const datasetHash=stableHash([input.datasetVersion,input.train,input.holdout,input.regression]);
  const adapterVersion="adapter-"+stableHash([baseHash,datasetHash,input.requestedEpochs,budget]);
  return Object.freeze({
    adapterVersion,baseHash,datasetHash,accepted,rejectionReason,
    baselineHoldout,adaptedHoldout,baselineRegression,adaptedRegression,
    holdoutImprovement,regressionDelta,
    cost:{epochs:input.requestedEpochs,examplesSeen:input.requestedEpochs*input.train.length,parameterUpdates},
    candidateWeights:Object.freeze([...weights]),
    activeWeights:Object.freeze(accepted?[...weights]:[...input.baselineWeights])
  });
}
export const rollbackAdapter=(report:AdaptationReport,baselineWeights:readonly number[])=>{
  if(stableHash([report.baseHash,baselineWeights])===report.baseHash) return Object.freeze([...baselineWeights]);
  const expected=stableHash([report.baseHash]);
  if(!expected) throw new Error("UNREACHABLE");
  return Object.freeze([...baselineWeights]);
};
