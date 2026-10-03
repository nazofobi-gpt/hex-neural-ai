import { useState } from "react";
import { HexCanvas } from "./HexCanvas";

type View = "Home" | "Projects" | "Recents" | "Starred" | "Templates" | "Activity" | "Builder";
const nav: View[] = ["Home","Projects","Recents","Starred","Templates","Activity"];

export function App() {
  const [view,setView]=useState<View>("Home");
  const [project,setProject]=useState<string | null>(null);
  const [created,setCreated]=useState(false);
  const openGuided=()=>{setProject("First Neural Workflow");setCreated(true);setView("Projects");};
  if(view==="Builder") return <main className="app-shell"><header className="topbar"><button onClick={()=>setView("Projects")}>← Project overview</button><div><p className="eyebrow">Workspace / {project}</p><h1>Builder</h1></div></header><HexCanvas /></main>;
  return <main className="product-shell">
    <nav className="sidebar" aria-label="Primary navigation"><div className="brand">Hex Neural AI</div><button className="quick" onClick={openGuided}>+ Quick create</button>{nav.map(item=><button key={item} aria-current={view===item?"page":undefined} onClick={()=>setView(item)}>{item}</button>)}</nav>
    <section className="workspace"><header className="product-topbar"><div><p className="eyebrow">Personal workspace</p><h1>{view}</h1></div><span className="account">Local preview · no production account data</span></header>
    {view==="Home" && <div className="content"><section className="hero"><p className="eyebrow">First run</p><h2>Build a useful workflow before opening the canvas.</h2><p>Start from a guided goal or an example. You can inspect every step before entering Builder.</p><button className="primary" onClick={openGuided}>Create guided project</button></section><div className="cards"><article><h3>Starter templates</h3><p>Research → verify → summarize</p><button onClick={openGuided}>Use template</button></article><article><h3>Example project</h3><p>Support triage with explicit review gates.</p><button onClick={openGuided}>Open example</button></article></div></div>}
    {view==="Projects" && <div className="content">{!project?<section className="empty"><h2>No projects yet</h2><p>Create a guided project; no developer setup is required.</p><button className="primary" onClick={openGuided}>Create project</button></section>:<><nav className="breadcrumb" aria-label="Breadcrumb">Personal workspace / Projects / {project}</nav><section className="project-card"><div><p className="eyebrow">Project overview</p><h2>{project}</h2><p>Goal: prepare a reviewed neural workflow without hidden runtime actions.</p></div><button className="primary" onClick={()=>setView("Builder")}>Enter builder</button></section><ol className="checklist" aria-label="First-run checklist"><li className={created?"done":""}>Project created</li><li className="done">Guided template selected</li><li>Review graph in Builder</li><li>Run when providers are connected</li></ol></>}</div>}
    {view!=="Home"&&view!=="Projects"&&<div className="content"><section className="empty"><h2>{view}</h2><p>This workspace has no {view.toLowerCase()} yet. The empty state is intentional and does not represent demo data.</p><button onClick={()=>setView("Home")}>Back to Home</button></section></div>}
    </section></main>;
}
