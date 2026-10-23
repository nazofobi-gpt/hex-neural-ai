# Hex Neural Application Protocol (HNAP) v0.1

Status: Draft / normative core  
Repository: `nazofobi-gpt/hex-neural-ai`  
Branch: `feat/protocol-v0.1`

## 1. Purpose

HNAP defines the minimum interoperable model for a recursive hexagonal AI application graph.

The protocol separates two concerns:

1. **Semantic data plane** — carries application payloads such as text, JSON, files, images, audio, embeddings, references and tool outputs.
2. **Neural control plane** — carries adaptive control state such as spikes/events, activations, gating, routing decisions, eligibility traces and plastic synaptic weights.

A semantic payload MUST NOT be forced through the neural microcircuit as raw spike data. The neural plane controls how, when and where semantic work is executed.

## 2. Normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are normative requirements.

## 3. Core invariants

### HNAP-I-001 — Recursive interface equivalence

A single cell and a collapsed cluster MUST expose the same external interface class.

```
CellInterface == ClusterInterface
```

Consumers MUST NOT need to know whether an endpoint is backed by one cell or a nested cluster.

### HNAP-I-002 — Six-face topology

Every externally connectable cell MUST expose exactly six directional faces indexed `0..5`.

### HNAP-I-003 — Touch defines eligibility, not full connectivity

Geometric face contact MAY create an inter-cell connection opportunity.

Contact MUST NOT imply all-to-all neuronal connectivity.

### HNAP-I-004 — Semantic/neural separation

Semantic payload data MUST be transported independently from the neural control state.

### HNAP-I-005 — Learned state cannot grant authority

Learned neural state MUST NOT modify:
- authentication
- authorization
- billing limits
- secret access
- network permissions
- tool capabilities
- data-retention policy
- deployment policy

### HNAP-I-006 — Versioned execution

Every executable run MUST identify:
- graph version
- runtime version
- model/tool versions where applicable
- neural checkpoint when neural state is used
- deterministic/random seed where relevant

### HNAP-I-007 — Bounded recurrence

A recurrent graph MUST enforce finite execution guards.

At minimum:
- maximum hop count
- maximum wall-clock runtime
- maximum external model/tool calls
- maximum cost budget or equivalent resource budget

### HNAP-I-008 — Reversible learning

User-driven adaptive state MUST be checkpointable and resettable.

## 4. Coordinate system

HNAP v0.1 uses axial hex coordinates:

```
(q, r)
```

The six neighbor directions are implementation-defined constants but MUST be deterministic and globally consistent inside one graph version.

A node's visual coordinate does not define its neural cluster membership.

## 5. HexCell

A `HexCell` is the fundamental visible computational primitive.

### Required fields

```ts
type HexCell = {
  id: string
  kind: NodeKind
  level: number
  parentId: string | null

  coordinate: {
    q: number
    r: number
  }

  faces: [Face, Face, Face, Face, Face, Face]

  neuralCircuitRef: string | null
  config: Record<string, unknown>
  stateRef: string | null

  createdAt: string
  updatedAt: string
}
```

### NodeKind

HNAP v0.1 reserves:

```
input
output
model
compute
memory
control
tool
interface
evaluator
axon
cluster
```

Implementations MAY introduce experimental kinds using a vendor namespace.

Example:

```
vendor.example.custom_search
```

## 6. Face

A `Face` is the only direct local attachment surface of a cell.

```ts
type Face = {
  index: 0 | 1 | 2 | 3 | 4 | 5

  semanticChannels: SemanticChannel[]
  projectionPopulation: string[]

  inputPolicy: PortPolicy
  outputPolicy: PortPolicy

  acceptedSchemas: string[]
  connectionIds: string[]
}
```

A face MAY support semantic traffic, neural projection traffic or both.

## 7. SemanticChannel

A semantic channel describes a payload contract.

```ts
type SemanticChannel = {
  id: string
  direction: "input" | "output" | "bidirectional"
  transport: "message" | "stream" | "request_response"
  schema: string
  optional: boolean
}
```

The `schema` field MUST reference either:
- a registered HNAP schema URI,
- a JSON Schema URI,
- a MIME-style type,
- or a project-local schema identifier.

Examples:

```
text/plain
application/json
image/png
embedding/f32
project://schemas/creative-brief
artifact/ref
```

## 8. Connection

A `Connection` links one face to another.

```ts
type Connection = {
  id: string

  source: {
    nodeId: string
    faceIndex: 0 | 1 | 2 | 3 | 4 | 5
  }

  target: {
    nodeId: string
    faceIndex: 0 | 1 | 2 | 3 | 4 | 5
  }

  semanticBindings: SemanticBinding[]
  neuralBridgeRef: string | null

  enabled: boolean
  createdAt: string
}
```

Unless the connection is explicitly implemented by an `axon` or another routing primitive, directly connected cells SHOULD occupy geometrically adjacent coordinates with opposing faces.

## 9. SemanticBinding

```ts
type SemanticBinding = {
  sourceChannelId: string
  targetChannelId: string
  transformRef: string | null
}
```

A compiler MUST reject incompatible bindings unless an explicit transform is available.

## 10. NeuralCircuit

HNAP v0.1 defines the neural circuit as an adaptive controller, not as the semantic payload processor.

Default experimental profile:

```
neuronsPerCell = 32
```

This value is NOT a biological constant and MUST remain configurable.

```ts
type NeuralCircuit = {
  id: string
  profile: string

  neurons: Neuron[]
  synapses: Synapse[]

  plasticity: PlasticityConfig
  homeostasis: HomeostasisConfig

  checkpointRef: string | null
}
```

## 11. Neuron

Initial reference implementations SHOULD support Leaky Integrate-and-Fire neurons.

```ts
type Neuron = {
  id: string

  role: "excitatory" | "inhibitory"

  membranePotential: number
  threshold: number
  decay: number

  targetFiringRate: number | null
  lastSpikeStep: number | null

  projectionFaces: number[]
}
```

A neuron MAY project to zero, one or multiple faces.

## 12. Synapse

```ts
type Synapse = {
  id: string

  sourceNeuronId: string
  targetNeuronId: string

  weight: number
  delaySteps: number

  sign: "excitatory" | "inhibitory"

  eligibilityTrace: number
  plasticityMode: string

  enabled: boolean
}
```

A cell MUST NOT default to a fully connected recurrent network.

Connectivity SHOULD be sparse and generated from a configurable probability model.

## 13. Connectivity model

The reference connectivity model SHOULD support a probability function of the form:

```
P(i -> j) =
  f(
    source neuron role,
    target neuron role,
    spatial distance,
    common neighbors,
    cluster membership,
    activity history
  )
```

No single biological percentage is globally normative.

Biological calibration values MUST be stored with metadata describing:
- species
- brain region
- cortical layer
- cell type
- experimental method
- source citation

## 14. Projection populations

Each face MAY expose a subset of neurons as its projection population.

Example:

```
face 0 -> [N2, N8, N11, N21]
face 1 -> [N3, N7, N14, N26]
...
```

When two faces attach, the runtime MAY initialize weak inter-cell synapses between eligible projection neurons.

These synapses MAY strengthen, weaken or be pruned according to bounded learning rules.

## 15. Cluster

A `Cluster` is a set of child cells represented externally as one cell.

```ts
type Cluster = {
  id: string
  childNodeIds: string[]
  childConnectionIds: string[]

  macroFaces: [MacroFace, MacroFace, MacroFace, MacroFace, MacroFace, MacroFace]

  summarizedStateRef: string | null
}
```

HNAP does NOT require clusters to contain exactly seven cells.

The common center-plus-six-neighbors grouping is a UI convention, not a biological law.

## 16. MacroFace

A cluster compiler MUST derive external macro faces from child boundary faces.

```ts
type MacroFace = {
  index: 0 | 1 | 2 | 3 | 4 | 5
  exposedChildFaces: {
    nodeId: string
    faceIndex: number
  }[]
  semanticChannels: SemanticChannel[]
  projectionPopulation: string[]
}
```

External callers interact with the macro face exactly as they would with a normal cell face.

## 17. Signal

Runtime execution is event-driven.

```ts
type Signal = {
  id: string
  traceId: string

  kind: "semantic" | "neural" | "control"

  payloadRef: string | null
  schema: string | null

  originNodeId: string
  currentNodeId: string

  hopCount: number
  ttl: number

  createdAt: string
}
```

Large semantic payloads SHOULD use stable artifact references instead of duplicating payload bytes inside signals.

## 18. Artifact

```ts
type Artifact = {
  id: string
  mimeType: string
  storageRef: string

  sizeBytes: number | null
  hash: string | null

  metadata: Record<string, unknown>
}
```

## 19. Execution run

```ts
type Run = {
  id: string

  graphVersion: string
  runtimeVersion: string
  neuralCheckpointRef: string | null

  modelVersions: Record<string, string>
  seed: string | null

  startedAt: string
  finishedAt: string | null

  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exhausted"

  resourceBudget: ResourceBudget
  resourceUsage: ResourceUsage

  traceRef: string
}
```

## 20. Runtime budgets

```ts
type ResourceBudget = {
  maxHops: number
  maxRuntimeMs: number
  maxExternalCalls: number
  maxCostUnits: number | null
}
```

The compiler MUST refuse an executable graph with no recurrence/resource guard.

## 21. Neural execution

The neural plane MAY participate in:
- route selection
- gate selection
- model selection
- prompt/template selection
- evaluator selection
- memory retrieval selection
- execution timing
- confidence or readiness estimation

The neural plane MUST NOT independently bypass hard runtime policy.

## 22. User feedback event

```ts
type UserFeedbackEvent = {
  id: string
  runId: string

  nodeId: string | null
  artifactId: string | null

  action:
    | "explicit_positive"
    | "explicit_negative"
    | "save"
    | "publish"
    | "use"
    | "edit_and_use"
    | "regenerate"
    | "undo"
    | "delete"

  reward: number | null
  scope: "session" | "project" | "user" | "global"

  createdAt: string
}
```

Reward coefficients are product parameters, not biological constants.

Weak ambiguous telemetry such as hover time MUST NOT be treated as strong positive reward by default.

## 23. Plasticity

A reference implementation MAY use an eligibility-trace model:

```
e_ij(t+1) = gamma * e_ij(t) + local_activity_term
```

and a reward-modulated update:

```
delta_w_ij = eta * reward * e_ij
```

All updates MUST be:
- bounded,
- checkpointed,
- auditable,
- reversible.

## 24. Homeostasis

The reference runtime MUST include a mechanism that prevents uncontrolled persistent excitation or permanent inactivity.

Implementations MAY regulate:
- synaptic scaling,
- firing thresholds,
- gain,
- target firing rates.

## 25. Pruning

A synapse MAY be disabled or pruned when its strength and utility remain below configured thresholds.

Pruning MUST NOT destroy the ability to restore a prior checkpoint.

## 26. Personalization scopes

Adaptive state MUST be partitionable into:

```
SESSION
PROJECT
USER
GLOBAL
```

Cross-project or global learning MUST NOT be inferred solely from project-level consent.

## 27. Foundation-model boundary

A live user interaction MUST NOT directly mutate foundation-model weights in the reference product architecture.

Online adaptation SHOULD operate through:
- routing,
- prompting,
- local controller state,
- preference models,
- memory selection,
- bounded neural plasticity.

Foundation-model training belongs to a separate consented offline pipeline.

## 28. Security model

Security policy is external to the adaptive graph.

The runtime MUST evaluate capability permissions before every external side effect.

Untrusted semantic payloads MUST NOT be interpreted as authority.

The implementation MUST distinguish:
- system policy
- user instruction
- trusted application configuration
- untrusted external data

## 29. Axon / relay node

Long-range communication is represented through an explicit relay primitive.

An `axon` node:
- MAY forward semantic traffic,
- MAY carry neural bridge traffic,
- SHOULD NOT alter payload semantics unless explicitly configured,
- MAY collapse visually into a long-range edge at higher zoom levels.

## 30. Semantic zoom

The renderer SHOULD expose abstraction levels:

1. application / macro cluster
2. functional cluster
3. individual hex nodes
4. neural inspector

Neural details are an advanced inspection surface and SHOULD NOT be the default application-authoring view.

## 31. Compiler responsibilities

Before execution, the graph compiler MUST validate:

- node identity uniqueness
- coordinate validity
- face indices
- face adjacency where required
- semantic schema compatibility
- connection directionality
- cluster parent/child integrity
- macro-face derivation
- neural circuit references
- recurrence/resource guards
- tool capability requirements
- security policy bindings
- model/tool availability
- graph version integrity

A graph with compiler errors MUST NOT execute.

## 32. Deterministic baseline

Before an adaptive neural controller is enabled, the same graph MUST be executable with a deterministic baseline controller.

This is required for:
- correctness testing,
- reproducibility,
- regression analysis,
- SNN value measurement.

## 33. SNN evaluation gate

A spiking neural controller MUST be benchmarked against at least one simpler baseline such as:
- deterministic rules,
- contextual bandit,
- MLP/router.

Minimum evaluation dimensions:
- task completion
- accepted output rate
- edit burden
- latency
- external-model cost
- adaptation speed
- stability

SNN architecture MUST NOT become a mandatory production dependency solely because it is biologically inspired.

## 34. Reference implementation defaults

These are defaults, not protocol laws:

```
neuronsPerCell = 32
visualClusterPattern = center_plus_six
defaultNeuralModel = LIF
defaultRendering = WebGL
defaultCanvasCoordinates = axial_hex
```

## 35. Public repository safety

The public repository MUST NOT contain:
- API keys
- OAuth tokens
- access tokens
- passwords
- personal user data
- private automation state
- private Google Drive identifiers unless explicitly intended for publication
- production secrets

Environment configuration MUST use placeholders such as `.env.example`.

## 36. v0.1 acceptance criteria

HNAP v0.1 is ready to freeze when:

1. Core domain objects have machine-readable schemas.
2. Six-face connection rules are testable.
3. Cell/cluster interface equivalence is testable.
4. Typed semantic bindings can be validated.
5. Semantic and neural planes are represented separately.
6. Runtime recurrence guards are mandatory.
7. Learning state is checkpointable/resettable.
8. Security authority is outside learned state.
9. A deterministic controller can execute the protocol without an SNN.
10. At least one reference graph passes schema + compiler validation.

## 37. Deferred from v0.1

Explicitly deferred:
- biological realism beyond the stated controller abstraction
- neuromorphic hardware
- native mobile runtimes
- real-time multi-user editing
- plugin marketplace
- autonomous permission escalation
- direct foundation-model online weight updates
- universal biological connection constants

## 38. Versioning

Protocol versions use semantic versioning after v1.0.

During pre-1.0 development:
- breaking schema changes increment the minor version,
- non-breaking additions increment the patch version.

Every serialized graph MUST include:

```
"protocolVersion": "0.1"
```

## 39. Next implementation milestone

After this protocol draft:

1. publish machine-readable schema,
2. add protocol validation tests,
3. create a minimal TypeScript protocol package,
4. build axial coordinate and six-face adjacency primitives,
5. create one deterministic two-cell signal-flow fixture,
6. create one recursive seven-cell cluster fixture.
