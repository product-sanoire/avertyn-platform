"use client";
// Avertyn — ⌘K command palette. Global search (disputes, accounts, contacts,
// files, tasks) + jump-to-screen + quick actions, keyboard-driven.
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const TYPE_LABEL = { dispute: "Dispute", account: "Account", contact: "Contact", file: "File", task: "Task" };
const TYPE_BADGE = { dispute: "b-red", account: "b-indigo", contact: "b-teal", file: "b-grey", task: "b-sage" };

export function CommandPalette({ orgId, rows, tabs, onNavigate, onSelectDispute, onImport, onAutopilot, onClose }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc("global_search", { p_org: orgId || null, p_q: q.trim() });
      if (live) setResults(Array.isArray(data) ? data : []);
    }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [q, orgId]);

  const ql = q.trim().toLowerCase();
  const commands = [
    ...tabs.map((t, i) => ({ kind: "nav", label: t, sub: "Go to screen", run: () => onNavigate(i) })),
    { kind: "action", label: "Import data", sub: "Bulk-load disputes, claims, org setup", run: onImport },
    { kind: "action", label: "Run autopilot", sub: "Tick the governed agent across open disputes", run: onAutopilot },
  ].filter((c) => !ql || c.label.toLowerCase().includes(ql));

  function selectResult(r) {
    if (r.type === "dispute") { const row = (rows || []).find((x) => x.external_ref === r.ref); if (row) return onSelectDispute(row.id); }
    if (r.type === "task") return onNavigate(Math.max(0, tabs.indexOf("Workspace")));
    onClose();
  }

  const items = [
    ...commands.map((c) => ({ ...c, _t: "cmd" })),
    ...results.map((r) => ({ _t: "res", type: r.type, label: r.label, sub: r.sub, run: () => selectResult(r) })),
  ];
  useEffect(() => { setActive(0); }, [q, results.length]);

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[active]?.run(); }
    else if (e.key === "Escape") { onClose(); }
  }

  return (
    <div className="modal-bg" style={{ alignItems: "flex-start", paddingTop: "11vh" }} onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cmdk-in">
          <span className="cmdk-ic">⌕</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search disputes, initiators, tasks — or jump to a screen…" />
          <span className="kbd">esc</span>
        </div>
        <div className="cmdk-list">
          {items.length === 0 ? <div className="cmdk-empty">No matches.</div> : items.map((it, i) => (
            <div key={i} className={"cmdk-row" + (i === active ? " on" : "")} onMouseEnter={() => setActive(i)} onClick={() => it.run()}>
              <span className={"badge " + (it._t === "cmd" ? (it.kind === "nav" ? "b-ink" : "b-amber") : (TYPE_BADGE[it.type] || "b-grey"))}>
                {it._t === "cmd" ? (it.kind === "nav" ? "Go" : "Do") : (TYPE_LABEL[it.type] || it.type)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cmdk-l">{it.label}</div>
                {it.sub && <div className="cmdk-s">{it.sub}</div>}
              </div>
              {i === active && <span className="kbd">↵</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
