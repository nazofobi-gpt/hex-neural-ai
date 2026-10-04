import { useMemo, useState } from "react";
import { BoundedLearner } from "../../../packages/bounded-learning/src/index";
import { compileGraph } from "../../../packages/runtime/src/compiler";
import { runExecutableGraph } from "../../../packages/runtime/src/runtime";
import type { RunReceipt } from "../../../packages/runtime/src/types";
import type { Face, HexCell, HnapGraph } from "../../../packages/protocol/src/types";

const NOW = "2026-10-05T00:00:00+02:00";
const GRAPH_VERSION = "private-alpha-v1";
const LEARNING_SCOPE = "private-alpha-demo";
const ROUTE_ACTION = "synthetic-route";

function emptyFace(index: number): Face {
  return {
    index: index as Face["index"],
    semanticChannels: [],
    projectionPopulation: [],
    inputPolicy: "allow",
    outputPolicy: "allow",
    acceptedSchemas: [],
    connectionIds: [],
  };
}

function node(
  id: string,
  kind: HexCell["kind"],
  q: number,
  permission: string | null = null,
): HexCell {
  const faces = Array.from({ length: 6 }, (_, index) =>
    emptyFace(index),
  ) as HexCell["faces"];

  if (q > 0) {
    faces[3] = {
      ...emptyFace(3),
      semanticChannels: [
        {
          id: `${id}.in`,
          direction: "input",
          transport: "message",
          schema: "application/json",
          optional: false,
        },
      ],
      acceptedSchemas: ["application/json"],
    };
  }

  if (q < 4) {
    faces[0] = {
      ...emptyFace(0),
      semanticChannels: [
        {
          id: `${id}.out`,
          direction: "output",
          transport: "message",
          schema: "application/json",
          optional: false,
        },
      ],
      acceptedSchemas: ["application/json"],
    };
  }

  return {
    id,
    kind,
    level: 0,
    parentId: null,
    coordinate: { q, r: 0 },
    faces,
    neuralCircuitRef: null,
    config:
      permission === null
        ? { label: id }
        : { label: id, permission },
    stateRef: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function graphForGoal(goal: string): HnapGraph {
  const input = node("input", "input", 0);
  const transform = node("transform", "compute", 1);
  const tool = node("tool", "tool", 2, "tool.alpha.synthetic");
  const evaluator = node("evaluator", "evaluator", 3);
  const output = node("output", "output", 4);
  const nodes = [input, transform, tool, evaluator, output];

  return {
    protocolVersion: "0.1",
    id: "private-alpha-flow",
    version: GRAPH_VERSION,
    nodes,
    connections: nodes.slice(0, -1).map((source, index) => {
      const target = nodes[index + 1]!;
      return {
        id: `edge-${index + 1}`,
        source: { nodeId: source.id, faceIndex: 0 },
        target: { nodeId: target.id, faceIndex: 3 },
        semanticBindings: [
          {
            sourceChannelId: `${source.id}.out`,
            targetChannelId: `${target.id}.in`,
            transformRef: null,
          },
        ],
        neuralBridgeRef: null,
        enabled: true,
        createdAt: NOW,
      };
    }),
    clusters: [],
    neuralCircuits: [],
    resourceBudget: {
      maxHops: 8,
      maxRuntimeMs: 100,
      maxExternalCalls: 2,
      maxCostUnits: 10,
    },
  };
}

function adapters(iteration: number, goal: string, learningScore: number) {
  return {
    byNodeId: {
      transform: {
        id: "alpha.transform",
        execute: ({ signal }: { signal: { payloadRef: string | null } }) => ({
          payloadRef: `${signal.payloadRef}:normalized`,
          durationMs: 1,
        }),
      },
      tool: {
        id: "alpha.synthetic-tool",
        execute: ({ signal }: { signal: { payloadRef: string | null } }) => ({
          payloadRef: `${signal.payloadRef}:generated`,
          externalCalls: 1,
          costUnits: 1,
          durationMs: 2,
          artifact: {
            id: `alpha-artifact-${iteration}`,
            mimeType: "application/json",
            storageRef: `artifact://private-alpha/${iteration}`,
            metadata: {
              synthetic: true,
              goal,
              learningScore,
              publishSideEffect: false,
            },
          },
        }),
      },
      evaluator: {
        id: "alpha.evaluator",
        execute: ({ signal }: { signal: { payloadRef: string | null } }) => ({
          payloadRef: `${signal.payloadRef}:accepted`,
          durationMs: 1,
        }),
      },
    },
  };
}

export function PrivateAlphaDemo() {
  const [goal, setGoal] = useState(
    "Create a bounded synthetic artifact and improve the next run from explicit feedback.",
  );
  const [compiled, setCompiled] = useState<ReturnType<typeof compileGraph> | null>(
    null,
  );
  const [receipt, setReceipt] = useState<RunReceipt | null>(null);
  const [iteration, setIteration] = useState(0);
  const [learningScore, setLearningScore] = useState(0);
  const learner = useMemo(
    () => new BoundedLearner(GRAPH_VERSION, 204),
    [],
  );

  const build = () => {
    setCompiled(
      compileGraph(graphForGoal(goal), 204, {
        allowedPermissions: ["tool.alpha.synthetic"],
      }),
    );
    setReceipt(null);
    setIteration(0);
  };

  const run = () => {
    if (!compiled?.ok) return;
    const nextIteration = iteration + 1;
    const result = runExecutableGraph(compiled.executable, {
      runId: `alpha-run-${nextIteration}`,
      startedAt: NOW,
      completedAt: NOW,
      initialPayloadRef: `goal://${encodeURIComponent(goal)}`,
      initialSchema: "application/json",
      traceId: "alpha-trace",
      adapters: adapters(nextIteration, goal, learningScore),
    });
    setIteration(nextIteration);
    setReceipt(result);
  };

  const feedback = (signal: "positive" | "negative") => {
    learner.observe({
      signal,
      scope: "PROJECT",
      scopeId: LEARNING_SCOPE,
      action: ROUTE_ACTION,
      ts: Date.parse(NOW),
    });
    setLearningScore(learner.score("PROJECT", LEARNING_SCOPE, ROUTE_ACTION));
  };

  const reset = () => {
    learner.reset("PROJECT", LEARNING_SCOPE);
    setLearningScore(learner.score("PROJECT", LEARNING_SCOPE, ROUTE_ACTION));
  };

  return (
    <section className="alpha-panel" aria-label="Private alpha acceptance">
      <div className="alpha-intro">
        <p className="eyebrow">G-204 · Private alpha acceptance</p>
        <h2>Goal → graph → run → artifact → feedback → next run</h2>
        <p>
          Deterministic runtime is the default. SNN remains optional R&amp;D because
          the measured synthetic benchmark showed no quality advantage and a
          materially higher latency/cost proxy.
        </p>
      </div>

      <label className="alpha-goal">
        Natural-language goal
        <textarea
          aria-label="Natural-language goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </label>

      <div className="alpha-actions">
        <button type="button" onClick={build}>Build graph</button>
        <button type="button" onClick={run} disabled={!compiled?.ok}>
          {iteration === 0 ? "Run" : "Run next iteration"}
        </button>
        <button type="button" onClick={() => feedback("positive")} disabled={!receipt}>
          Accept result
        </button>
        <button type="button" onClick={() => feedback("negative")} disabled={!receipt}>
          Request revision
        </button>
        <button type="button" onClick={reset}>Reset project learning</button>
      </div>

      <div className="alpha-grid">
        <article>
          <h3>Graph</h3>
          <p data-testid="alpha-graph-status">
            {compiled === null
              ? "Not compiled"
              : compiled.ok
                ? `${compiled.executable.nodes.length} nodes · ${compiled.executable.edges.length} edges · ${compiled.executable.graphVersion}`
                : `Compile rejected: ${compiled.errors.map((error) => error.code).join(", ")}`}
          </p>
        </article>

        <article>
          <h3>Run</h3>
          <p data-testid="alpha-run-status">
            {receipt
              ? `${receipt.runId} · ${receipt.status} · ${receipt.termination.code}`
              : "Not run"}
          </p>
          <p data-testid="alpha-provenance">
            {receipt?.artifacts[0]
              ? `artifact=${receipt.artifacts[0].id} · graph=${receipt.artifacts[0].provenance.graphVersion} · adapter=${receipt.artifacts[0].provenance.adapterId}`
              : "No artifact"}
          </p>
        </article>

        <article>
          <h3>Learning</h3>
          <p data-testid="alpha-learning-score">
            PROJECT score {learningScore.toFixed(3)}
          </p>
          <p>Explicit feedback only; scope is inspectable/resettable.</p>
        </article>
      </div>

      <div className="alpha-checklist" aria-label="Private alpha checklist">
        <h3>Acceptance checklist</h3>
        <ul>
          <li>Deterministic baseline remains the product default.</li>
          <li>Learning is project-scoped, bounded and resettable.</li>
          <li>Hard permission/cost policy is outside learned state.</li>
          <li>Artifacts retain graph/run/adapter provenance.</li>
          <li>This demo uses synthetic adapters and performs no external publish.</li>
        </ul>
      </div>
    </section>
  );
}
