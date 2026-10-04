import { ClusterDemoCanvas } from "./ClusterDemoCanvas";
import { HexCanvas } from "./HexCanvas";
import { PrivateAlphaDemo } from "./PrivateAlphaDemo";

export function App() {
  const params = new URLSearchParams(window.location.search);
  const clusterDemo = params.has("clusterDemo");
  const alphaDemo = params.has("alphaDemo");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            HNAP v0.1 · {alphaDemo ? "G-204" : clusterDemo ? "G-199" : "G-197"}
          </p>
          <h1>Hex Neural AI Editor</h1>
        </div>
        <p className="topbar-copy">
          {alphaDemo
            ? "Private-alpha acceptance uses the real deterministic runtime and bounded learning packages with synthetic adapters and no publish side effect."
            : clusterDemo
              ? "Recursive clusters preserve graph identity while semantic zoom switches between leaf, nested-cluster, and application-cluster views."
              : "Deterministic axial geometry with a PixiJS canvas. Drag hexes, pan, zoom, and inspect six-face adjacency."}
        </p>
      </header>
      {alphaDemo ? (
        <PrivateAlphaDemo />
      ) : clusterDemo ? (
        <ClusterDemoCanvas />
      ) : (
        <HexCanvas />
      )}
    </main>
  );
}
