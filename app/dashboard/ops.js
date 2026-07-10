"use client";
// Avertyn dashboard — ops-layer screens: Inbox, Tasks, Calendar, Predictions.
// Each is self-contained (loads its own org-scoped data via RLS) so the main
// dashboard file stays lean. Reuses the Ink & Paper component classes.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { money } from "../../lib/format";

const PRIO = { urgent: "red", high: "amber", med: "ink", low: "grey" };
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");
const fmtDateTime = (t) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

// ---------------------------------------------------------------- Inbox
export function InboxView({ email, orgId, onErr }) {
  const [threads, setThreads] = useState([]);
  const [active, setActive] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const loadThreads = useCallback(async () => {
    const { data, error } = await supabase.from("comm_threads")
      .select("id, subject, status, unread, last_at, dispute_id").order("last_at", { ascending: false });
    if (error) return onErr(error.message);
    setThreads(data || []);
    if (!active && data && data.length) setActive(data[0].id);
  }, [active, onErr]);

  const openThread = useCallback(async (id) => {
    setActive(id);
    const { data } = await supabase.from("comm_messages").select("*").eq("thread_id", id).order("at", { ascending: true });
    setMsgs(data || []);
    const t = threads.find((x) => x.id === id);
    if (t?.unread) { await supabase.from("comm_threads").update({ unread: false }).eq("id", id); loadThreads(); }
  }, [threads, loadThreads]);

  useEffect(() => { loadThreads(); }, [loadThreads]);
  useEffect(() => { if (active) openThread(active); /* eslint-disable-next-line */ }, [active]);

  async function send() {
    if (!reply.trim() || !active) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("comm_messages").insert({
        org_id: orgId, thread_id: active, direction: "out", channel: "email", sender: email, body: reply.trim(),
      });
      if (error) throw error;
      await supabase.from("comm_threads").update({ last_at: new Date().toISOString(), unread: false }).eq("id", active);
      setReply(""); await openThread(active); await loadThreads();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }

  const activeThread = threads.find((t) => t.id === active);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100%", overflow: "hidden" }}>
      <div className="list">
        <div className="lhdr"><b>Inbox</b><span className="ct">{threads.length} threads</span></div>
        {threads.length === 0 ? <p className="muted" style={{ padding: 16 }}>No threads.</p> : threads.map((t) => (
          <div key={t.id} className={"lrow" + (t.id === active ? " on" : "")} onClick={() => setActive(t.id)}>
            <div className="r1"><b>{t.subject}</b>{t.unread && <span className="badge b-red"><i className="dot d-red" />New</span>}</div>
            <div className="r2">{t.status} · {fmtDate(t.last_at)}</div>
          </div>
        ))}
      </div>
      <div className="detail">
        {!activeThread ? <p className="muted">Select a thread…</p> : (
          <div>
            <div className="dh"><h1>{activeThread.subject}</h1><span className="sub">{activeThread.status}</span></div>
            <div className="panel"><div className="pb" style={{ paddingTop: 12 }}>
              {msgs.length === 0 ? <p className="muted">No messages.</p> : msgs.map((m) => (
                <div key={m.id} style={{ margin: "10px 0", display: "flex", justifyContent: m.direction === "out" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth: "78%", background: m.direction === "out" ? "var(--ink)" : "var(--card)", color: m.direction === "out" ? "#fff" : "var(--ink)", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 13px" }}>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.body}</div>
                    <div style={{ fontSize: 10, opacity: .7, marginTop: 5 }}>{m.sender} · {m.channel} · {fmtDateTime(m.at)}</div>
                  </div>
                </div>
              ))}
            </div></div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…"
                onKeyDown={(e) => e.key === "Enter" && send()}
                style={{ flex: 1, padding: "11px 13px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit", fontSize: 13 }} />
              <button className="btn btn-a" disabled={busy || !reply.trim()} onClick={send}>{busy ? "Sending…" : "Send"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Tasks
export function TasksView({ email, orgId, userId, onErr, embedded }) {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("work_items")
      .select("id, title, description, status, priority, due_at, dispute_id, completed_at")
      .order("status", { ascending: true }).order("due_at", { ascending: true, nullsFirst: false });
    if (error) return onErr(error.message);
    setTasks(data || []);
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  async function toggle(t) {
    const done = t.status === "done";
    const { error } = await supabase.from("work_items")
      .update({ status: done ? "todo" : "done", completed_at: done ? null : new Date().toISOString() }).eq("id", t.id);
    if (error) return onErr(error.message);
    load();
  }
  async function add() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("work_items").insert({
        org_id: orgId, title: title.trim(), status: "todo", priority: "med", created_by: userId,
      });
      if (error) throw error;
      setTitle(""); load();
    } catch (e) { onErr(e.message); }
    setBusy(false);
  }

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  return (
    <div>
      {!embedded && <div className="dh"><h1>Tasks</h1><span className="sub">{open.length} open · {done.length} done</span></div>}
      <div style={{ display: "flex", gap: 8, marginTop: embedded ? 0 : 14, maxWidth: 560 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…"
          onKeyDown={(e) => e.key === "Enter" && add()}
          style={{ flex: 1, padding: "11px 13px", border: "1px solid var(--line)", borderRadius: 10, font: "inherit", fontSize: 13 }} />
        <button className="btn btn-a" disabled={busy || !title.trim()} onClick={add}>{busy ? "Adding…" : "Add task"}</button>
      </div>
      <div className="panel">
        <div className="ph">Open</div>
        <div className="pb">
          {open.length === 0 ? <p className="muted">Nothing open. 🎉</p> : open.map((t) => <TaskRow key={t.id} t={t} onToggle={toggle} />)}
        </div>
      </div>
      {done.length > 0 && (
        <div className="panel">
          <div className="ph">Done</div>
          <div className="pb">{done.map((t) => <TaskRow key={t.id} t={t} onToggle={toggle} />)}</div>
        </div>
      )}
    </div>
  );
}
function TaskRow({ t, onToggle }) {
  const done = t.status === "done";
  return (
    <div className="frow" style={{ alignItems: "center" }}>
      <button onClick={() => onToggle(t)} title={done ? "Reopen" : "Complete"}
        style={{ width: 20, height: 20, borderRadius: 6, border: "1.5px solid var(--line)", background: done ? "var(--ok)" : "#fff", color: "#fff", fontSize: 12, flex: "none", cursor: "pointer" }}>
        {done ? "✓" : ""}
      </button>
      <div style={{ flex: 1 }}>
        <b style={{ textDecoration: done ? "line-through" : "none", color: done ? "var(--mut)" : "var(--ink)" }}>{t.title}</b>
        <div className="sub">{t.status.replace("_", " ")}{t.due_at ? " · due " + fmtDate(t.due_at) : ""}</div>
      </div>
      <span className={"badge b-" + (PRIO[t.priority] || "grey")}>{t.priority}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Calendar
const CAL_TONE = { deadline: "red", filing: "clay", meeting: "indigo", reminder: "sage" };
export function CalendarView({ onErr, embedded }) {
  const [items, setItems] = useState([]);
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const [{ data: ev, error: e1 }, { data: dl, error: e2 }] = await Promise.all([
      supabase.from("calendar_events").select("id, title, kind, start_at"),
      supabase.from("deadlines").select("id, kind, due_at, status"),
    ]);
    if (e1 || e2) return onErr((e1 || e2).message);
    setItems([
      ...(ev || []).map((x) => ({ id: "e" + x.id, title: x.title, kind: x.kind, at: x.start_at })),
      ...(dl || []).map((x) => ({ id: "d" + x.id, title: (x.kind || "deadline").replace(/_/g, " "), kind: "deadline", at: x.due_at })),
    ].filter((x) => x.at));
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + offset);
  const year = base.getFullYear(), month = base.getMonth();
  const monthName = base.toLocaleString(undefined, { month: "long", year: "numeric" });
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = {};
  items.forEach((i) => { const d = new Date(i.at); if (d.getFullYear() === year && d.getMonth() === month) (byDay[d.getDate()] = byDay[d.getDate()] || []).push(i); });
  const cells = []; for (let i = 0; i < firstDow; i++) cells.push(null); for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const t = new Date(); const isToday = (d) => d && offset === 0 && t.getFullYear() === year && t.getMonth() === month && t.getDate() === d;

  const nav = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="mini" onClick={() => setOffset(offset - 1)}>‹</button>
      <b style={{ fontFamily: "var(--disp)", fontSize: 17, minWidth: 158, textAlign: "center" }}>{monthName}</b>
      <button className="mini" onClick={() => setOffset(offset + 1)}>›</button>
      {offset !== 0 && <button className="mini" onClick={() => setOffset(0)}>Today</button>}
    </div>
  );
  return (
    <div>
      {embedded
        ? <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>{nav}</div>
        : <div className="dh"><h1>Calendar</h1><span className="sub">Business-day, holiday-aware windows</span>
          <div style={{ marginLeft: "auto" }}>{nav}</div></div>}
      <div className="panel" style={{ marginTop: embedded ? 0 : 16 }}>
        <div className="calgrid calhead">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="calh">{d}</div>)}
        </div>
        <div className="calgrid">
          {cells.map((d, i) => (
            <div key={i} className={"calcell" + (d ? "" : " empty") + (isToday(d) ? " today" : "")}>
              {d && <div className="caln">{d}</div>}
              {d && (byDay[d] || []).slice(0, 3).map((ev, j) => (
                <div key={j} className={"calev b-" + (CAL_TONE[ev.kind] || "grey")} title={ev.title + " · " + fmtDateTime(ev.at)}>{ev.title}</div>
              ))}
              {d && (byDay[d] || []).length > 3 && <div className="calmore">+{(byDay[d] || []).length - 3} more</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Predictions
function driverList(drivers) {
  if (!drivers) return [];
  if (Array.isArray(drivers)) return drivers.map((d) => (typeof d === "string" ? d : (d.factor || d.name || d.label || JSON.stringify(d))));
  if (typeof drivers === "object") return Object.entries(drivers).map(([k, v]) => `${k}: ${v}`);
  return [String(drivers)];
}
const RECO_TONE = { challenge: "red", defend: "teal", settle: "amber" };
export function PredictionsView({ onErr, onOpen, embedded }) {
  const [preds, setPreds] = useState([]);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("predictions")
      .select("id, dispute_id, win_prob, recommended, recommended_offer, expected_value, drivers, model_version, created_at, disputes(external_ref, cpt_code, demand_amount, qpa_amount)")
      .order("created_at", { ascending: false });
    if (error) return onErr(error.message);
    // latest per dispute
    const seen = new Set(); const latest = [];
    (data || []).forEach((p) => { if (!seen.has(p.dispute_id)) { seen.add(p.dispute_id); latest.push(p); } });
    setPreds(latest);
  }, [onErr]);
  useEffect(() => { load(); }, [load]);

  const avgWin = preds.length ? Math.round(preds.reduce((a, p) => a + Number(p.win_prob || 0), 0) / preds.length * 100) : 0;
  const totalEV = preds.reduce((a, p) => a + Number(p.expected_value || 0), 0);

  const rowEls = preds.map((p) => {
    const wp = Math.round(Number(p.win_prob || 0) * 100);
    const d = p.disputes || {};
    return (
      <div key={p.id} className="frow" style={{ alignItems: "flex-start", cursor: onOpen ? "pointer" : "default" }} onClick={() => onOpen && onOpen(p.dispute_id)}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b>#{d.external_ref || "—"}</b>
            <span className="muted" style={{ fontSize: 11.5 }}>CPT {d.cpt_code}</span>
            <span className={"badge b-" + (RECO_TONE[p.recommended] || "grey")}>{p.recommended}</span>
          </div>
          <div className="track" style={{ marginTop: 7, maxWidth: 320 }}>
            <div className="fill" style={{ width: wp + "%", background: wp >= 60 ? "var(--ok)" : wp >= 40 ? "var(--warn)" : "var(--sig)" }} />
          </div>
          <div className="sub" style={{ marginTop: 5 }}>
            {wp}% plan-prevails · optimal offer {money(p.recommended_offer)} · EV {money(p.expected_value)}
            {p.model_version ? " · " + p.model_version : ""}
          </div>
          {driverList(p.drivers).length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
              {driverList(p.drivers).slice(0, 4).map((dr, i) => <span key={i} className="badge b-grey">{dr}</span>)}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontWeight: 600 }}>{money(d.demand_amount)}</div>
          <div className="muted" style={{ fontSize: 11 }}>QPA {money(d.qpa_amount)}</div>
        </div>
      </div>
    );
  });

  // Embedded: a native Overview panel (no page header / KPI cards) so it reads as
  // part of the command center rather than a pasted-in screen.
  if (embedded) {
    return (
      <div className="panel" style={{ marginTop: 18 }}>
        <div className="ph">Predicted outcomes
          <span className="act"><span className="muted" style={{ fontSize: 11 }}>{preds.length ? `${preds.length} modeled · avg ${avgWin}% plan-prevails · ${money(totalEV)} modeled EV` : "win-probability & optimal-offer model"}</span></span>
        </div>
        {preds.length === 0
          ? <p className="muted" style={{ padding: 16 }}>No predictions yet — run “Predict outcome” on a case.</p>
          : <div className="pb" style={{ paddingTop: 10 }}>{rowEls}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="dh"><h1>Predictions</h1><span className="sub">Win-probability &amp; optimal-offer model · what the agent acts on</span></div>
      <div className="cards" style={{ marginTop: 14 }}>
        <div className="kpi-tile"><div className="l">Cases modeled</div><div className="n">{preds.length}</div></div>
        <div className="kpi-tile"><div className="l">Avg plan-prevail</div><div className="n">{avgWin}%</div></div>
        <div className="kpi-tile"><div className="l">Modeled expected value</div><div className="n">{money(totalEV)}</div></div>
      </div>
      {preds.length === 0 ? <div className="empty"><div className="eh">No predictions yet</div><div className="es">Run the model to score win-probability and the optimal offer per dispute.</div></div>
        : <div className="panel"><div className="pb" style={{ paddingTop: 10 }}>{rowEls}</div></div>}
    </div>
  );
}
