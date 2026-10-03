import { DesignSystemFixture } from "./DesignSystemFixture";
import { HexCanvas } from "./HexCanvas";

export function App() {
  if (new URLSearchParams(window.location.search).has("design-system")) {
    return <DesignSystemFixture />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">HNAP v0.1 · G-197</p>
          <h1>Hex Neural AI Editor</h1>
        </div>
        <p className="topbar-copy">
          Deterministic axial geometry with a PixiJS canvas. Drag hexes, pan,
          zoom, and inspect six-face adjacency.
        </p>
      </header>
      <HexCanvas />
    </main>
  );
}
