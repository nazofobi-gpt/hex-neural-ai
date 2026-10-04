import { useState } from "react";
import { HexCanvas } from "./HexCanvas";

type View = "Home" | "Projects" | "Recents" | "Starred" | "Templates" | "Activity" | "Builder";
type Pending = "signIn" | "workspace" | "project" | null;

const nav: View[] = ["Home", "Projects", "Recents", "Starred", "Templates", "Activity"];
const waitForMock = () => new Promise<void>((resolve) => window.setTimeout(resolve, 250));

export function App() {
  const [view, setView] = useState<View>("Home");
  const [account, setAccount] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Personal workspace");
  const [project, setProject] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [failProjectOnce, setFailProjectOnce] = useState(
    () => new URLSearchParams(window.location.search).get("mockProjectError") === "1",
  );

  const signIn = async () => {
    setError(null);
    setPending("signIn");
    await waitForMock();
    setAccount("Preview account");
    setPending(null);
  };

  const createWorkspace = async () => {
    if (!workspaceName.trim()) {
      setError("Workspace name is required.");
      return;
    }
    setError(null);
    setPending("workspace");
    await waitForMock();
    setWorkspace(workspaceName.trim());
    setPending(null);
  };

  const openGuided = async () => {
    setError(null);
    setPending("project");
    await waitForMock();
    if (failProjectOnce) {
      setFailProjectOnce(false);
      setError("The preview project could not be created. Nothing was saved; retry safely.");
      setPending(null);
      return;
    }
    setProject("First Neural Workflow");
    setCreated(true);
    setView("Projects");
    setPending(null);
  };

  if (!account || !workspace) {
    return (
      <main className="gate-shell">
        <section className="gate-card" aria-live="polite">
          <p className="eyebrow">First-run setup</p>
          {!account ? (
            <>
              <h1>Welcome to Hex Neural AI</h1>
              <p>Sign in to create an isolated preview account. No production credentials are requested.</p>
              <button className="primary" disabled={pending === "signIn"} onClick={signIn}>
                {pending === "signIn" ? "Signing in…" : "Continue with preview account"}
              </button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace();
              }}
            >
              <h1>Create your workspace</h1>
              <p>Workspaces keep projects and navigation state separate from the canvas.</p>
              <label htmlFor="workspace-name">Workspace name</label>
              <input
                id="workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
              <button className="primary" disabled={pending === "workspace"} type="submit">
                {pending === "workspace" ? "Creating workspace…" : "Create workspace"}
              </button>
            </form>
          )}
          {error && <p role="alert" className="error">{error}</p>}
        </section>
      </main>
    );
  }

  if (view === "Builder") {
    return (
      <main className="app-shell">
        <header className="topbar">
          <button onClick={() => setView("Projects")}>← Project overview</button>
          <div><p className="eyebrow">{workspace} / {project}</p><h1>Builder</h1></div>
        </header>
        <HexCanvas />
      </main>
    );
  }

  return (
    <main className="product-shell">
      <nav className="sidebar" aria-label="Primary navigation">
        <div className="brand">Hex Neural AI</div>
        <button className="quick" disabled={pending === "project"} onClick={() => void openGuided()}>
          {pending === "project" ? "Creating…" : "+ Quick create"}
        </button>
        {nav.map((item) => (
          <button key={item} aria-current={view === item ? "page" : undefined} onClick={() => setView(item)}>{item}</button>
        ))}
      </nav>
      <section className="workspace">
        <header className="product-topbar">
          <div><p className="eyebrow">{workspace}</p><h1>{view}</h1></div>
          <span className="account">{account} · local preview · no production account data</span>
        </header>
        {error && (
          <div className="content compact">
            <section className="error-panel" role="alert">
              <h2>Project creation failed</h2>
              <p>{error}</p>
              <button onClick={() => void openGuided()}>Retry project creation</button>
            </section>
          </div>
        )}
        {view === "Home" && !error && (
          <div className="content">
            <section className="hero">
              <p className="eyebrow">First run</p>
              <h2>Build a useful workflow before opening the canvas.</h2>
              <p>Start from a guided goal or an example. You can inspect every step before entering Builder.</p>
              <button className="primary" disabled={pending === "project"} onClick={() => void openGuided()}>
                {pending === "project" ? "Creating project…" : "Create guided project"}
              </button>
            </section>
            <div className="cards">
              <article><h3>Starter templates</h3><p>Research → verify → summarize</p><button onClick={() => void openGuided()}>Use template</button></article>
              <article><h3>Example project</h3><p>Support triage with explicit review gates.</p><button onClick={() => void openGuided()}>Open example</button></article>
            </div>
          </div>
        )}
        {view === "Projects" && (
          <div className="content">
            {!project ? (
              <section className="empty"><h2>No projects yet</h2><p>Create a guided project; no developer setup is required.</p><button className="primary" onClick={() => void openGuided()}>Create project</button></section>
            ) : (
              <>
                <nav className="breadcrumb" aria-label="Breadcrumb">{workspace} / Projects / {project}</nav>
                <section className="project-card"><div><p className="eyebrow">Project overview</p><h2>{project}</h2><p>Goal: prepare a reviewed neural workflow without hidden runtime actions.</p></div><button className="primary" onClick={() => setView("Builder")}>Enter builder</button></section>
                <ol className="checklist" aria-label="First-run checklist"><li className={created ? "done" : ""}>Project created</li><li className="done">Guided template selected</li><li>Review graph in Builder</li><li>Run when providers are connected</li></ol>
              </>
            )}
          </div>
        )}
        {view !== "Home" && view !== "Projects" && (
          <div className="content"><section className="empty"><h2>{view}</h2><p>This workspace has no {view.toLowerCase()} yet. The empty state is intentional and does not represent demo data.</p><button onClick={() => setView("Home")}>Back to Home</button></section></div>
        )}
      </section>
    </main>
  );
}
