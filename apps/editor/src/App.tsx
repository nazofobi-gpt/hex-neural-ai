import { ClusterDemoCanvas } from "./ClusterDemoCanvas";
import { HexCanvas } from "./HexCanvas";

export function App() {
  const clusterDemo = new URLSearchParams(window.location.search).has(
    "clusterDemo",
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">
            HNAP v0.1 · {clusterDemo ? "G-199" : "G-197"}
          </p>
          <h1>Hex Neural AI Editor</h1>
        </div>
        <p className="topbar-copy">
          {clusterDemo
            ? "Recursive clusters preserve graph identity while semantic zoom switches between leaf, nested-cluster, and application-cluster views."
            : "Deterministic axial geometry with a PixiJS canvas. Drag hexes, pan, zoom, and inspect six-face adjacency."}
        </p>
      </header>
      {clusterDemo ? <ClusterDemoCanvas /> : <HexCanvas />}
    </main>
  );
}
