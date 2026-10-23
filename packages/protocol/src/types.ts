export const HNAP_PROTOCOL_VERSION = "0.1" as const;

export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5;

export type NodeKind =
  | "input"
  | "output"
  | "model"
  | "compute"
  | "memory"
  | "control"
  | "tool"
  | "interface"
  | "evaluator"
  | "axon"
  | "cluster"
  | `vendor.${string}`;

export type PortPolicy = "allow" | "deny" | "conditional";
export type ChannelDirection = "input" | "output" | "bidirectional";
export type ChannelTransport = "message" | "stream" | "request_response";

export interface AxialCoordinate {
  q: number;
  r: number;
}

export interface SemanticChannel {
  id: string;
  direction: ChannelDirection;
  transport: ChannelTransport;
  schema: string;
  optional: boolean;
}

export interface Face {
  index: FaceIndex;
  semanticChannels: SemanticChannel[];
  projectionPopulation: string[];
  inputPolicy: PortPolicy;
  outputPolicy: PortPolicy;
  acceptedSchemas: string[];
  connectionIds: string[];
}

export interface HexCell {
  id: string;
  kind: NodeKind;
  level: number;
  parentId: string | null;
  coordinate: AxialCoordinate;
  faces: [Face, Face, Face, Face, Face, Face];
  neuralCircuitRef: string | null;
  config: Record<string, unknown>;
  stateRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticBinding {
  sourceChannelId: string;
  targetChannelId: string;
  transformRef: string | null;
}

export interface ConnectionEndpoint {
  nodeId: string;
  faceIndex: FaceIndex;
}

export interface Connection {
  id: string;
  source: ConnectionEndpoint;
  target: ConnectionEndpoint;
  semanticBindings: SemanticBinding[];
  neuralBridgeRef: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface Neuron {
  id: string;
  role: "excitatory" | "inhibitory";
  membranePotential: number;
  threshold: number;
  decay: number;
  targetFiringRate: number | null;
  lastSpikeStep: number | null;
  projectionFaces: FaceIndex[];
}

export interface Synapse {
  id: string;
  sourceNeuronId: string;
  targetNeuronId: string;
  weight: number;
  delaySteps: number;
  sign: "excitatory" | "inhibitory";
  eligibilityTrace: number;
  plasticityMode: string;
  enabled: boolean;
}

export interface PlasticityConfig {
  enabled: boolean;
  bounded: true;
  [key: string]: unknown;
}

export interface HomeostasisConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface NeuralCircuit {
  id: string;
  profile: string;
  neurons: Neuron[];
  synapses: Synapse[];
  plasticity: PlasticityConfig;
  homeostasis: HomeostasisConfig;
  checkpointRef: string | null;
}

export interface MacroFace {
  index: FaceIndex;
  exposedChildFaces: ConnectionEndpoint[];
  semanticChannels: SemanticChannel[];
  projectionPopulation: string[];
}

export interface Cluster {
  id: string;
  childNodeIds: string[];
  childConnectionIds: string[];
  macroFaces: [MacroFace, MacroFace, MacroFace, MacroFace, MacroFace, MacroFace];
  summarizedStateRef: string | null;
}

export interface ResourceBudget {
  maxHops: number;
  maxRuntimeMs: number;
  maxExternalCalls: number;
  maxCostUnits: number | null;
}

export interface HnapGraph {
  protocolVersion: typeof HNAP_PROTOCOL_VERSION;
  id: string;
  version: string;
  nodes: HexCell[];
  connections: Connection[];
  clusters?: Cluster[];
  neuralCircuits?: NeuralCircuit[];
  resourceBudget: ResourceBudget;
}

export interface Signal {
  id: string;
  traceId: string;
  kind: "semantic" | "neural" | "control";
  payloadRef: string | null;
  schema: string | null;
  originNodeId: string;
  currentNodeId: string;
  hopCount: number;
  ttl: number;
  createdAt: string;
}

export interface Artifact {
  id: string;
  mimeType: string;
  storageRef: string;
  sizeBytes: number | null;
  hash: string | null;
  metadata: Record<string, unknown>;
}

export type FeedbackAction =
  | "explicit_positive"
  | "explicit_negative"
  | "save"
  | "publish"
  | "use"
  | "edit_and_use"
  | "regenerate"
  | "undo"
  | "delete";

export interface UserFeedbackEvent {
  id: string;
  runId: string;
  nodeId: string | null;
  artifactId: string | null;
  action: FeedbackAction;
  reward: number | null;
  scope: "session" | "project" | "user" | "global";
  createdAt: string;
}
