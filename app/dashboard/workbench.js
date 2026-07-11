"use client";
// Avertyn — Workbench tab + Tools drawer. Gets Register / Templates / Library /
// Programs out of the masthead and gives them (a) a browsable home — the
// Workbench tab, a left sub-nav that renders each tool's page inline (embedded
// mode, so the routes still work standalone) — and (b) a quick-reach right-side
// drawer you can pop from any tab.
import AuthoritiesPage from "../authorities/page";
import TemplatesPage from "../templates/page";
import Library from "../library/page";
import ProgramsPage from "../programs/page";

export const WB_TOOLS = [
  { id: "templates", icon: "▤", cls: "templates", name: "Templates", href: "/templates", desc: "40 argument templates by jurisdiction — start any brief." },
  { id: "register", icon: "§", cls: "register", name: "Register", href: "/authorities", desc: "Living legal-citation registry — every {{cite}} stays current." },
  { id: "library", icon: "▥", cls: "library", name: "Library", href: "/library", desc: "Every case document & exhibit, searchable." },
  { id: "programs", icon: "◍", cls: "programs", name: "Programs", href: "/programs", desc: "Coverage programs, determinations & payment integrity." },
];

export function WorkbenchView({ sub, setSub }) {
  const active = sub || "templates";
  const Panel = active === "register" ? AuthoritiesPage
    : active === "library" ? Library
    : active === "programs" ? ProgramsPage
    : TemplatesPage;
  return (
    <div className="wbx">
      <div className="wbxnav">
        <div className="wbxlbl">Workbench</div>
        {WB_TOOLS.map((t) => (
          <button key={t.id} className={"wbxitem " + t.cls + (active === t.id ? " on" : "")} onClick={() => setSub(t.id)}>
            <span className="ic">{t.icon}</span><span className="nm">{t.name}</span>
          </button>
        ))}
        <div className="wbxhint">These four used to live in the header. Open any full page from the drawer (⧉ Tools) too.</div>
      </div>
      <div className="wbxmain">
        <Panel embedded />
      </div>
    </div>
  );
}

export function ToolsDrawer({ open, onClose, onOpenTool, contextLabel }) {
  return (
    <>
      <div className={"tdscrim" + (open ? " on" : "")} onClick={onClose} />
      <div className={"tdrawer" + (open ? " on" : "")} role="dialog" aria-label="Tools">
        <div className="tdhd"><span className="tdi">⧉</span><b>Tools</b><button className="tdx" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="tdsearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: 14, height: 14 }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          Search tools, templates, authorities…
        </div>
        {contextLabel && <div className="tdctx">In context · <b>{contextLabel}</b> — jump to the QPA-defense template or the §149.510 authority.</div>}
        <div className="tdsec">
          {WB_TOOLS.map((t) => (
            <button key={t.id} className={"tdtool " + t.cls} onClick={() => onOpenTool(t.id)}>
              <span className="ic">{t.icon}</span>
              <span className="bd"><span className="nm">{t.name}</span><span className="ds">{t.desc}</span></span>
              <span className="go">→</span>
            </button>
          ))}
          <div className="tdlbl">Recent &amp; pinned</div>
          {[["▤", "QPA defense — §149.510", "template", "/templates"], ["§", "§149.510 — QPA methodology", "authority", "/authorities"], ["▥", "QPA exhibit — latest case", "library", "/library"], ["◍", "NCCI / MUE screening", "program", "/programs"]].map(([i, t, m, href]) => (
            <a key={t} className="tdqi" href={href}><span className="qi">{i}</span><span className="qt">{t}</span><span className="qm">{m}</span></a>
          ))}
        </div>
      </div>
    </>
  );
}
