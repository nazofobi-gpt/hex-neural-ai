import "./fixture-styles.css";

const states = ["selected", "running", "success", "warning", "error", "disabled", "locked", "offline", "stale", "partial"] as const;

export function DesignSystemFixture() {
  return (
    <main className="ds-fixture" data-testid="design-system-fixture">
      <header>
        <p className="eyebrow">G-256 deterministic visual fixture</p>
        <h1>Hex Neural design system</h1>
        <p>Every state combines a label, symbol, border treatment, and color.</p>
      </header>

      <section className="ds-panel" aria-labelledby="controls-heading">
        <h2 id="controls-heading">Forms and controls</h2>
        <label>Name <input className="ds-input" defaultValue="Capability node" /></label>
        <label>Runtime <select className="ds-select" defaultValue="local"><option value="local">Local</option><option value="cloud">Cloud</option></select></label>
        <button className="ds-button" type="button">Save node</button>
        <button className="ds-button" type="button" disabled aria-disabled="true">Unavailable</button>
      </section>

      <nav className="ds-tabs" aria-label="Fixture sections">
        <button className="ds-tab" type="button" role="tab" aria-selected="true">Overview</button>
        <button className="ds-tab" type="button" role="tab" aria-selected="false">History</button>
      </nav>

      <section className="ds-state-grid" aria-label="Semantic state matrix">
        {states.map((state) => (
          <article className="ds-panel" data-state={state} key={state} data-testid={`state-${state}`}>
            <span className="ds-state-marker" aria-hidden="true" />
            <strong>{state[0].toUpperCase() + state.slice(1)}</strong>
            <span className="sr-only"> state</span>
          </article>
        ))}
      </section>

      <section className="ds-panel" aria-labelledby="table-heading">
        <h2 id="table-heading">Table</h2>
        <table className="ds-table"><thead><tr><th>Node</th><th>Status</th></tr></thead><tbody><tr><td>Memory Fabric</td><td>Ready</td></tr><tr><td>Vision adapter</td><td>Offline</td></tr></tbody></table>
      </section>

      <aside className="ds-drawer" tabIndex={0} aria-label="Inspector drawer"><strong>Drawer</strong><p>Selection details remain keyboard reachable.</p></aside>
      <section className="ds-dialog" role="dialog" aria-modal="false" aria-labelledby="dialog-title" tabIndex={0}><h2 id="dialog-title">Dialog</h2><p>Review the bounded change before applying it.</p><button className="ds-button" type="button">Confirm</button></section>
      <span className="ds-tooltip" role="tooltip">Tooltip · provenance available</span>
      <div className="ds-toast" role="status" data-state="success"><span className="ds-state-marker" aria-hidden="true" />Toast · checkpoint saved</div>
    </main>
  );
}
