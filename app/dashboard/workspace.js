"use client";
// Avertyn — Workspace hub (Cockpit + Week + Month).
// One deadline-safe, case-aware surface. "Today" is the triage cockpit (a
// unified queue of deadlines, tasks and messages ranked by urgency, a focus
// pane, and a deadline-radar / team-load rail). Week and Month layer the same
// items onto a calendar. A persistent KPI ribbon + filters sit above all three.
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useLive } from "../../lib/useLive";
import { money, caseIdentity } from "../../lib/format";

const HOUR = 3600e3, DAY = 24 * HOUR, STALE_DAYS = 30;
const PRIO_TONE = { urgent: "red", high: "amber", med: "ink", low: "grey" };
const AV_COLORS = ["a1", "a2", "a3", "a4", "a5"];
const humanize = (s) => (s || "").replace(/_/g, " ").trim();
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtDT = (t) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
function initials(name) {
  const s = (name || "").replace(/@.*/, "").replace(/[^a-zA-Z ]/g, " ").trim();
  if (!s) return "—";
  const p = s.split(/\s+/); return ((p[0][0] || "") + (p[1] ? p[1][0] : "")).toUpperCase();
}
function avColor(key) { let h = 0; const s = String(key || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; }
function countdown(at, type, unread) {
  if (type === "message") return unread ? { txt: "reply", tone: "soon" } : { txt: "open", tone: "ok" };
  if (!at) return { txt: "no date", tone: "ok" };
  const diff = at.getTime() - Date.now();
  if (diff < 0) { const d = Math.max(1, Math.ceil(-diff / DAY)); return { txt: d + "d over", tone: "over" }; }
  const h = diff / HOUR;
  if (h < 24) return { txt: Math.max(1, Math.round(h)) + "h", tone: "soon" };
  const d = Math.round(h / DAY); return { txt: d + "d", tone: d <= 3 ? "soon" : "ok" };
}
// event colour class for calendar chips (urgency first, then type)
function chipClass(at, type, kind) {
  if (at) { const diff = at.getTime() - Date.now(); if (diff < 0) return "e-over"; if (diff <= 3 * DAY) return "e-soon"; }
  if (type === "task") return "e-task";
  const k = (kind || "").toLowerCase();
  if (type === "message" || /response|offer|notice/.test(k)) return "e-msg";
  return "e-idr";
}

export function WorkspaceHub({ email, orgId, userId, onErr }) {
  const [view, setView] = useState("today");            // today | week | month
  const [typeF, setTypeF] = useState("all");            // all | deadline | task | message
  const [ownerF, setOwnerF] = useState("all");          // all | <assignee text>
  const [sel, setSel] = useState(null);                 // selected feed item id
  const [focusMsgs, setFocusMsgs] = useState([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [weekOff, setWeekOff] = useState(0);
  const [monthOff, setMonthOff] = useState(0);
  const [showStale, setShowStale] = useState(false);    // include >30-day-overdue open deadlines

  const [deadlines, setDeadlines] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [threads, setThreads] = useState([]);
  const [events, setEvents] = useState([]);
  const [caseMap, setCaseMap] = useState({});
  const [users, setUsers] = useState([]);
  const selRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [dl, wi, th, ev, ds, us] = await Promise.all([
        supabase.from("deadlines").select("id, kind, due_at, status, dispute_id"),
        supabase.from("work_items").select("id, title, status, priority, due_at, dispute_id, assignee, completed_at"),
        supabase.from("comm_threads").select("id, subject, status, unread, last_at, dispute_id, assignee"),
        supabase.from("calendar_events").select("id, title, kind, start_at, dispute_id"),
        supabase.from("disputes").select("id, external_ref, claim_number, idr_registration_number, phase, cpt_code, demand_amount, qpa_amount, initiators(name), plans(name)"),
        supabase.from("app_users").select("email, full_name, active"),
      ]);
      const firstErr = [dl, wi, th, ev, ds, us].find((r) => r.error)?.error;
      if (firstErr) throw firstErr;
      setDeadlines(dl.data || []); setTasks(wi.data || []); setThreads(th.data || []); setEvents(ev.data || []);
      const cm = {}; (ds.data || []).forEach((d) => { cm[d.id] = d; }); setCaseMap(cm);
      setUsers(us.data || []);
    } catch (e) { onErr && onErr(e.message || String(e)); }
  }, [onErr]);
  useEffect(() => { load(); }, [load]);
  useLive("workspace", ["deadlines", "work_items", "comm_threads", "calendar_events"], load);

  const caseOf = useCallback((id) => (id && caseMap[id] ? caseMap[id] : null), [caseMap]);
  const labelOf = useCallback((id) => { const c = caseOf(id); return c ? caseIdentity(c) : null; }, [caseOf]);

  // ---- unified feed (deadlines + tasks + messages) -------------------------
  const feed = useMemo(() => {
    const items = [];
    for (const d of deadlines) {
      if (["done", "resolved", "met", "closed"].includes((d.status || "").toLowerCase())) continue;
      items.push({ id: "d" + d.id, type: "deadline", title: humanize(d.kind) || "Deadline", at: d.due_at ? new Date(d.due_at) : null, caseId: d.dispute_id, owner: null, status: d.status });
    }
    for (const t of tasks) {
      if ((t.status || "") === "done") continue;
      items.push({ id: "t" + t.id, type: "task", raw: t, title: t.title, at: t.due_at ? new Date(t.due_at) : null, caseId: t.dispute_id, owner: t.assignee, priority: t.priority, status: t.status });
    }
    for (const th of threads) {
      if ((th.status || "") === "closed" && !th.unread) continue;
      items.push({ id: "m" + th.id, type: "message", rawId: th.id, title: th.subject, at: th.last_at ? new Date(th.last_at) : null, caseId: th.dispute_id, owner: th.assignee, unread: th.unread, status: th.status });
    }
    return items;
  }, [deadlines, tasks, threads]);

  const bucketOf = (it) => {
    if (it.type === "message") return it.unread ? "soon" : "week";
    if (!it.at) return "week";
    const diff = it.at.getTime() - Date.now();
    if (diff < 0) return "over"; if (diff <= 3 * DAY) return "soon"; if (diff <= 7 * DAY) return "week"; return "later";
  };
  const passType = (it) => typeF === "all" || it.type === typeF;
  const passOwner = (it) => ownerF === "all" || it.owner === ownerF;
  // "Stale" = an open deadline overdue by more than 30 days (typically abandoned /
  // seed backlog). Hidden by default from both the queue and the Overdue KPI so
  // the cockpit stays actionable; toggle to include, or bulk-resolve them.
  const staleCutoff = Date.now() - STALE_DAYS * DAY;
  const isStale = (it) => it.type === "deadline" && it.at && it.at.getTime() < staleCutoff;
  const staleCount = feed.filter(isStale).length;
  const shown = feed.filter((it) => passType(it) && passOwner(it) && (showStale || !isStale(it)));

  const groups = useMemo(() => {
    const g = { over: [], soon: [], week: [] };
    for (const it of shown) { const b = bucketOf(it); if (g[b]) g[b].push(it); }
    const rank = (it) => (it.at ? it.at.getTime() : Infinity);
    Object.values(g).forEach((arr) => arr.sort((a, b) => rank(a) - rank(b)));
    return g;
  }, [shown]);

  const kpis = useMemo(() => {
    let over = 0, soon = 0, unread = 0, unassigned = 0;
    for (const it of feed) {
      if (it.type !== "message" && it.at) { const diff = it.at.getTime() - Date.now(); if (diff < 0) { if (showStale || !isStale(it)) over++; } else if (diff <= 3 * DAY) soon++; }
      if (it.type === "message" && it.unread) unread++;
      if ((it.type === "task" || it.type === "message") && !it.owner) unassigned++;
    }
    return { over, soon, unread, unassigned };
  }, [feed, showStale]); // eslint-disable-line

  // default selection → first overdue, else first soon
  useEffect(() => {
    if (sel && shown.some((i) => i.id === sel)) return;
    const first = groups.over[0] || groups.soon[0] || groups.week[0] || shown[0];
    if (first) setSel(first.id);
  }, [groups, shown, sel]);

  const selected = shown.find((i) => i.id === sel) || feed.find((i) => i.id === sel) || null;
  // load messages for a selected thread
  useEffect(() => {
    selRef.current = sel;
    if (selected && selected.type === "message") {
      supabase.from("comm_messages").select("*").eq("thread_id", selected.rawId).order("at", { ascending: true }).then(({ data }) => setFocusMsgs(data || []));
      if (selected.unread) supabase.from("comm_threads").update({ unread: false }).eq("id", selected.rawId).then(() => load());
    } else setFocusMsgs([]);
  }, [sel]); // eslint-disable-line

  async function sendReply() {
    if (!reply.trim() || !selected || selected.type !== "message") return;
    setBusy("send");
    try {
      const { error } = await supabase.from("comm_messages").insert({ org_id: orgId, thread_id: selected.rawId, direction: "out", channel: "email", sender: email, body: reply.trim() });
      if (error) throw error;
      await supabase.from("comm_threads").update({ last_at: new Date().toISOString(), unread: false }).eq("id", selected.rawId);
      setReply("");
      const { data } = await supabase.from("comm_messages").select("*").eq("thread_id", selected.rawId).order("at", { ascending: true });
      setFocusMsgs(data || []); load();
    } catch (e) { onErr && onErr(e.message); }
    setBusy("");
  }
  async function markTaskDone(t) {
    setBusy("done");
    try { const { error } = await supabase.from("work_items").update({ status: "done", completed_at: new Date().toISOString() }).eq("id", t.id); if (error) throw error; load(); }
    catch (e) { onErr && onErr(e.message); }
    setBusy("");
  }
  async function resolveDeadline(feedId) {
    setBusy("resolve");
    try { const { error } = await supabase.from("deadlines").update({ status: "met" }).eq("id", feedId.slice(1)); if (error) throw error; load(); }
    catch (e) { onErr && onErr(e.message); }
    setBusy("");
  }
  async function clearStale() {
    if (typeof window !== "undefined" && !window.confirm(`Resolve ${staleCount} deadline${staleCount === 1 ? "" : "s"} overdue by more than ${STALE_DAYS} days? They'll be marked handled and cleared from the queue.`)) return;
    setBusy("stale");
    try {
      const cutoff = new Date(staleCutoff).toISOString();
      const { error } = await supabase.from("deadlines").update({ status: "met" }).eq("status", "open").lt("due_at", cutoff);
      if (error) throw error; load();
    } catch (e) { onErr && onErr(e.message); }
    setBusy("");
  }

  // ---- team load -----------------------------------------------------------
  const teamLoad = useMemo(() => {
    const openTasks = tasks.filter((t) => (t.status || "") !== "done");
    const counts = {};
    for (const t of openTasks) { const k = t.assignee || ""; if (!k) continue; counts[k] = (counts[k] || 0) + 1; }
    const list = users.filter((u) => u.active !== false).map((u) => {
      const c = counts[u.email] || counts[u.full_name] || 0;
      return { key: u.email, name: u.full_name || u.email, count: c };
    }).filter((u) => u.count > 0);
    list.sort((a, b) => b.count - a.count);
    const max = Math.max(1, ...list.map((u) => u.count));
    return { list: list.slice(0, 6), max };
  }, [tasks, users]);

  // ---- deadline radar (next 7 days) ---------------------------------------
  const radar = useMemo(() => {
    const t0 = startOfDay(new Date()).getTime(), horizon = Date.now() + 7 * DAY;
    return shown.filter((it) => it.type !== "message" && it.at && it.at.getTime() >= t0 && it.at.getTime() <= horizon)
      .sort((a, b) => a.at - b.at).slice(0, 7);
  }, [shown]);

  // ---- owners for filter ---------------------------------------------------
  const owners = useMemo(() => {
    const s = new Set(); feed.forEach((i) => { if (i.owner) s.add(i.owner); });
    return Array.from(s);
  }, [feed]);

  return (
    <div className="wsroot">
      {/* view switch */}
      <div className="ws-bar">
        <div>
          <h2 className="ws-title">{view === "today" ? "Today" : view === "week" ? "This week" : "Calendar"}</h2>
          <div className="ws-sub">{view === "today" ? "Everything that needs you, ranked by urgency" : view === "week" ? "Deadlines, tasks & events by day" : "Business-day, holiday-aware windows & events"}</div>
        </div>
        <div className="ws-seg">
          {[["today", "◆ Today"], ["week", "▦ Week"], ["month", "▤ Month"]].map(([k, l]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* KPI ribbon */}
      <div className="ws-ribbon">
        <div className="ws-kpi warnbar" onClick={() => { setView("today"); }}><div className="l"><i className="dot d-red" />Overdue</div><div className="n" style={{ color: "var(--sig)" }}>{kpis.over}</div><div className="s">response &amp; filing windows past due</div></div>
        <div className="ws-kpi amberbar" onClick={() => { setView("today"); }}><div className="l"><i className="dot d-amber" />Due ≤ 72h</div><div className="n" style={{ color: "var(--warn)" }}>{kpis.soon}</div><div className="s">deadlines &amp; tasks</div></div>
        <div className="ws-kpi inkbar" onClick={() => { setView("today"); setTypeF("message"); }}><div className="l"><i className="dot d-ink" />Unread</div><div className="n">{kpis.unread}</div><div className="s">payer &amp; provider threads</div></div>
        <div className="ws-kpi greybar" onClick={() => { setView("today"); }}><div className="l"><i className="dot d-grey" />Unassigned</div><div className="n">{kpis.unassigned}</div><div className="s">need an owner</div></div>
      </div>

      {/* filters + legend */}
      <div className="ws-tools">
        {[["all", "All types"], ["deadline", "Deadlines"], ["task", "Tasks"], ["message", "Messages"]].map(([k, l]) => (
          <button key={k} className={"ws-fchip" + (typeF === k ? " on" : "")} onClick={() => setTypeF(k)}>{l}</button>
        ))}
        {owners.length > 0 && <span className="ws-div" />}
        {owners.slice(0, 4).map((o) => (
          <button key={o} className={"ws-av " + avColor(o) + (ownerF === o ? " ring" : "")} title={o} onClick={() => setOwnerF(ownerF === o ? "all" : o)}>{initials(o)}</button>
        ))}
        {ownerF !== "all" && <button className="ws-fchip" onClick={() => setOwnerF("all")}>All owners</button>}
        {staleCount > 0 && <span className="ws-div" />}
        {staleCount > 0 && <button className={"ws-fchip" + (showStale ? " on" : "")} onClick={() => setShowStale((s) => !s)} title={`Deadlines overdue by more than ${STALE_DAYS} days`}>{showStale ? "Hide stale" : `${staleCount} stale hidden`}</button>}
        {staleCount > 0 && <button className="ws-fchip" disabled={busy === "stale"} onClick={clearStale} title="Mark all stale deadlines handled">{busy === "stale" ? "Resolving…" : "Resolve stale"}</button>}
        <div className="ws-legend">
          <span><i style={{ background: "var(--sig)" }} />Overdue</span><span><i style={{ background: "var(--warn)" }} />Due soon</span>
          <span><i style={{ background: "var(--ok)" }} />Task</span><span><i style={{ background: "#3f5c8a" }} />Message</span><span><i style={{ background: "var(--ink)" }} />IDR event</span>
        </div>
      </div>

      {view === "today" && (
        <Cockpit groups={groups} sel={sel} setSel={setSel} labelOf={labelOf} caseOf={caseOf}
          selected={selected} focusMsgs={focusMsgs} reply={reply} setReply={setReply} sendReply={sendReply}
          markTaskDone={markTaskDone} resolveDeadline={resolveDeadline} busy={busy} radar={radar} teamLoad={teamLoad} />
      )}
      {view === "week" && <WeekView deadlines={deadlines} tasks={tasks} events={events} typeF={typeF} ownerF={ownerF} labelOf={labelOf} weekOff={weekOff} setWeekOff={setWeekOff} setView={setView} setSel={setSel} />}
      {view === "month" && <MonthView deadlines={deadlines} tasks={tasks} events={events} typeF={typeF} monthOff={monthOff} setMonthOff={setMonthOff} />}
    </div>
  );
}

/* ============================ Today cockpit ============================ */
const CAP = 8;
function Cockpit({ groups, sel, setSel, labelOf, caseOf, selected, focusMsgs, reply, setReply, sendReply, markTaskDone, resolveDeadline, busy, radar, teamLoad }) {
  const total = groups.over.length + groups.soon.length + groups.week.length;
  const icon = (t) => t === "message" ? "✉" : t === "task" ? "✓" : "▲";
  const Row = (it) => {
    const ci = labelOf(it.caseId);
    const cd = countdown(it.at, it.type, it.unread);
    return (
      <div key={it.id} className={"ws-qrow" + (sel === it.id ? " sel" : "")} onClick={() => setSel(it.id)}>
        <div className={"ws-ic " + it.type}>{icon(it.type)}</div>
        <div className="body">
          <div className="t">{it.title}</div>
          <div className="m">
            {ci && <span className="ws-cchip">{ci.number}</span>}
            {it.type === "task" && it.priority && <span className={"badge b-" + (PRIO_TONE[it.priority] || "grey")}>{it.priority}</span>}
            {it.type === "message" && it.unread && <span className="badge b-red"><i className="dot d-red" />New</span>}
            {(it.type === "task" || it.type === "message") && !it.owner && <span className="badge b-grey">unassigned</span>}
            {it.owner && <span className={"ws-av sm " + avColor(it.owner)} title={it.owner}>{initials(it.owner)}</span>}
          </div>
        </div>
        <div className={"ws-cdpill cd-" + cd.tone}>{cd.txt}</div>
      </div>
    );
  };
  return (
    <div className="ws-cockpit">
      <div className="ws-col">
        <div className="ws-colhd"><h3>Needs you now</h3><span className="ct">{total}</span></div>
        <div className="ws-scroll">
          {groups.over.length > 0 && <div className="ws-qgroup"><div className="glabel red"><i className="dot d-red" />Overdue · {groups.over.length}</div>{groups.over.slice(0, CAP).map(Row)}{groups.over.length > CAP && <div className="ws-morerow">+{groups.over.length - CAP} more overdue</div>}</div>}
          {groups.soon.length > 0 && <div className="ws-qgroup"><div className="glabel amber"><i className="dot d-amber" />Today &amp; next 72h</div>{groups.soon.slice(0, CAP).map(Row)}{groups.soon.length > CAP && <div className="ws-morerow">+{groups.soon.length - CAP} more</div>}</div>}
          {groups.week.length > 0 && <div className="ws-qgroup"><div className="glabel grey"><i className="dot d-grey" />This week</div>{groups.week.slice(0, CAP).map(Row)}{groups.week.length > CAP && <div className="ws-morerow">+{groups.week.length - CAP} more this week</div>}</div>}
          {total === 0 && <p className="muted" style={{ padding: 18 }}>Nothing needs you right now. 🎉</p>}
        </div>
      </div>

      <div className="ws-col">
        <div className="ws-read">
          {!selected ? <p className="muted" style={{ padding: 18 }}>Select an item…</p> : <FocusPane it={selected} caseOf={caseOf} labelOf={labelOf} msgs={focusMsgs} reply={reply} setReply={setReply} sendReply={sendReply} markTaskDone={markTaskDone} resolveDeadline={resolveDeadline} busy={busy} />}
        </div>
      </div>

      <div className="ws-rail">
        <h3>Deadline radar · 7 days</h3>
        <div className="ws-radar">
          {radar.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>Nothing in the next week.</p> : radar.map((it) => {
            const ci = labelOf(it.caseId); const cd = countdown(it.at, it.type);
            const day = it.at ? it.at.toLocaleDateString(undefined, { weekday: "short" }) : "—";
            return (<div key={it.id} className="ws-radrow" onClick={() => setSel(it.id)}>
              <span className="day" style={cd.tone === "over" ? { color: "var(--sig)" } : {}}>{cd.tone === "over" ? "now" : day}</span>
              <span className="rt">{it.title}{ci ? " · " + ci.number : ""}</span>
              <span className={"badge b-" + (cd.tone === "over" ? "red" : cd.tone === "soon" ? "amber" : "grey")}>{cd.txt}</span>
            </div>);
          })}
        </div>
        <h3>Team load</h3>
        {teamLoad.list.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No assigned work.</p> : teamLoad.list.map((u) => {
          const pct = Math.round(u.count / teamLoad.max * 100);
          const col = pct >= 85 ? "var(--sig)" : pct >= 60 ? "var(--warn)" : "var(--ok)";
          return (<div key={u.key} className="ws-teamrow"><span className={"ws-av " + avColor(u.key)}>{initials(u.name)}</span><div className="nm">{u.name}</div><div className="cap"><div className="load">{u.count} open</div><div className="capbar"><i style={{ width: pct + "%", background: col }} /></div></div></div>);
        })}
      </div>
    </div>
  );
}

function FocusPane({ it, caseOf, labelOf, msgs, reply, setReply, sendReply, markTaskDone, resolveDeadline, busy }) {
  const c = caseOf(it.caseId); const ci = labelOf(it.caseId);
  return (
    <>
      {c && (
        <div className="ws-ctx">
          <span className="ws-cchip" style={{ fontSize: 12 }}>{ci.number}</span>
          <span className={"badge b-" + (ci.phaseIdr ? "green" : "amber")}><i className={"dot d-" + (ci.phaseIdr ? "green" : "amber")} />{ci.phaseIdr ? "Federal IDR" : "Open negotiation"}</span>
          <span className="muted" style={{ fontSize: 12 }}>{[c.initiators?.name, c.cpt_code && ("CPT " + c.cpt_code), c.plans?.name].filter(Boolean).join(" · ")}</span>
          {c.demand_amount != null && <div className="qpa"><div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>Demand vs QPA</div><div className="n mono">{money(c.demand_amount)} <span className="faint">/ {money(c.qpa_amount)}</span></div></div>}
        </div>
      )}
      <h3 style={{ fontSize: 19, marginBottom: 4 }}>{it.title}</h3>
      {it.type === "message" ? (
        <>
          <div className="ws-thread">
            {msgs.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No messages.</p> : msgs.map((m) => (
              <div key={m.id} className={"ws-msg " + (m.direction === "out" ? "out" : "in")}>{m.body}<div className="mm">{m.sender} · {m.channel} · {fmtDT(m.at)}</div></div>
            ))}
          </div>
          <div className="ws-reply"><input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendReply()} placeholder="Write a reply…" /><button className="btn btn-a" disabled={busy === "send" || !reply.trim()} onClick={sendReply}>{busy === "send" ? "Sending…" : "Send"}</button></div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            {it.at ? (it.at.getTime() < Date.now() ? "Past due — resolve to clear it from Overdue." : "Due " + fmtDT(it.at) + ".") : "No date set."}
            {it.type === "task" && it.status ? " · " + humanize(it.status) : ""}
          </div>
          <div className="ws-toolbar">
            {it.type === "task" && <button className="btn btn-a" disabled={busy === "done"} onClick={() => markTaskDone(it.raw)}>{busy === "done" ? "…" : "✓ Mark done"}</button>}
            {it.type === "deadline" && <button className="btn btn-a" disabled={busy === "resolve"} onClick={() => resolveDeadline(it.id)}>{busy === "resolve" ? "…" : "✓ Mark resolved"}</button>}
            {c && <a className="btn" href={`/dispute/${it.caseId}`}>Open case →</a>}
          </div>
        </>
      )}
    </>
  );
}

/* ============================ Week ============================ */
function WeekView({ deadlines, tasks, events, typeF, ownerF, labelOf, weekOff, setWeekOff, setView, setSel }) {
  const monday = useMemo(() => { const t = startOfDay(new Date()); const dow = (t.getDay() + 6) % 7; t.setDate(t.getDate() - dow + weekOff * 7); return t; }, [weekOff]);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const today = startOfDay(new Date());
  const pass = (type) => typeF === "all" || type === typeF;

  const allItems = useMemo(() => {
    const arr = [];
    if (pass("deadline")) for (const d of deadlines) { if (["done", "resolved", "met"].includes((d.status || "").toLowerCase())) continue; if (d.due_at) arr.push({ id: "d" + d.id, type: "deadline", title: humanize(d.kind) || "Deadline", at: new Date(d.due_at), caseId: d.dispute_id }); }
    if (pass("task")) for (const t of tasks) { if ((t.status || "") === "done") continue; if (t.due_at && (ownerF === "all" || t.assignee === ownerF)) arr.push({ id: "t" + t.id, type: "task", title: t.title, at: new Date(t.due_at), caseId: t.dispute_id, owner: t.assignee }); }
    // calendar events read as scheduled milestones (respect deadline/message type filters loosely)
    if (typeF === "all") for (const e of events) { if (e.start_at) arr.push({ id: "e" + e.id, type: "event", title: e.title || humanize(e.kind), at: new Date(e.start_at), caseId: e.dispute_id, kind: e.kind }); }
    return arr;
  }, [deadlines, tasks, events, typeF, ownerF]);

  const carried = allItems.filter((i) => i.type !== "event" && i.at < today).sort((a, b) => a.at - b.at);
  const dayItems = (d) => allItems.filter((i) => sameDay(i.at, d) && i.at >= today).sort((a, b) => a.at - b.at);
  const openItem = (i) => { setSel(i.id.replace(/^e/, "")); setView("today"); };

  return (
    <div className="ws-weekwrap">
      <div className="ws-wknav">
        <button className="mini" onClick={() => setWeekOff(weekOff - 1)}>‹</button>
        <b style={{ fontFamily: "var(--disp)", fontSize: 15 }}>{monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – {days[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}</b>
        <button className="mini" onClick={() => setWeekOff(weekOff + 1)}>›</button>
        {weekOff !== 0 && <button className="mini" onClick={() => setWeekOff(0)}>This week</button>}
      </div>
      <div className="ws-weekgrid">
        <div className="ws-wkover">
          <div className="oh"><i className="dot d-red" />Carried over · {carried.length}</div>
          {carried.length === 0 ? <p className="muted" style={{ fontSize: 11.5 }}>Nothing overdue. 🎉</p> : carried.map((i) => {
            const ci = labelOf(i.caseId);
            return <div key={i.id} className="ws-ev e-over" onClick={() => openItem(i)}><span className="et">{i.title}</span>{ci && <span className="cq">{ci.number}</span>}</div>;
          })}
          {carried.length > 0 && <div className="ohnote">Overdue windows stay pinned here until resolved — they never fall off the calendar.</div>}
        </div>
        <div className="ws-wkcols">
          {days.map((d, idx) => {
            const isToday = sameDay(d, today); const weekend = idx >= 5; const its = dayItems(d);
            return (
              <div key={idx} className={"ws-wkcol" + (weekend ? " weekend" : "") + (isToday ? " today" : "")}>
                <div className="ws-wkdh"><div className="wd">{d.toLocaleDateString(undefined, { weekday: "short" })}{isToday ? " · today" : ""}</div><div className="dn">{d.getDate()}</div></div>
                <div className="ws-wkevs">
                  {its.slice(0, 6).map((i) => { const ci = labelOf(i.caseId); return (
                    <div key={i.id} className={"ws-ev " + chipClass(i.at, i.type, i.kind)} onClick={() => openItem(i)}><span className="et">{i.title}</span>{ci && <span className="cq">{ci.number}</span>}</div>
                  ); })}
                  {its.length > 6 && <div className="ws-more">+{its.length - 6} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================ Month ============================ */
function MonthView({ deadlines, tasks, events, typeF, monthOff, setMonthOff }) {
  const base = useMemo(() => { const b = new Date(); b.setDate(1); b.setMonth(b.getMonth() + monthOff); b.setHours(0, 0, 0, 0); return b; }, [monthOff]);
  const year = base.getFullYear(), month = base.getMonth();
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = startOfDay(new Date());
  const pass = (type) => typeF === "all" || type === typeF;

  const byDay = useMemo(() => {
    const m = {};
    const push = (dt, item) => { const d = new Date(dt); if (d.getFullYear() === year && d.getMonth() === month) (m[d.getDate()] = m[d.getDate()] || []).push({ ...item, at: d }); };
    if (pass("deadline")) deadlines.forEach((d) => { if (d.due_at && !["done", "resolved", "met"].includes((d.status || "").toLowerCase())) push(d.due_at, { type: "deadline", title: humanize(d.kind) || "Deadline", kind: d.kind }); });
    if (pass("task")) tasks.forEach((t) => { if (t.due_at && (t.status || "") !== "done") push(t.due_at, { type: "task", title: t.title }); });
    if (typeF === "all") events.forEach((e) => { if (e.start_at) push(e.start_at, { type: "event", title: e.title || humanize(e.kind), kind: e.kind }); });
    return m;
  }, [deadlines, tasks, events, typeF, year, month]);

  const cells = [];
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = 0; i < firstDow; i++) cells.push({ out: true, n: prevDays - firstDow + 1 + i });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ n: d, day: d });
  while (cells.length % 7 !== 0) cells.push({ out: true, n: cells.length % 7 });

  return (
    <div className="ws-mwrap">
      <div className="ws-mnav">
        <button className="ws-navb" onClick={() => setMonthOff(monthOff - 1)}>‹</button>
        <h3>{base.toLocaleString(undefined, { month: "long", year: "numeric" })}</h3>
        <button className="ws-navb" onClick={() => setMonthOff(monthOff + 1)}>›</button>
        {monthOff !== 0 && <button className="mini" onClick={() => setMonthOff(0)}>Today</button>}
      </div>
      <div className="ws-mhead">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d}>{d}</span>)}</div>
      <div className="ws-mgrid">
        {cells.map((c, i) => {
          const weekend = i % 7 >= 5; const evs = c.day ? (byDay[c.day] || []) : [];
          const isToday = c.day && monthOff === 0 && sameDay(new Date(year, month, c.day), today);
          return (
            <div key={i} className={"ws-mcell" + (c.out ? " out" : "") + (weekend ? " weekend" : "") + (isToday ? " today" : "")}>
              <span className="dn">{c.n}</span>
              {evs.slice(0, 3).map((e, j) => <div key={j} className={"ws-ev " + chipClass(e.at, e.type, e.kind)} title={e.title}><span className="et">{e.title}</span></div>)}
              {evs.length > 3 && <div className="ws-more">+{evs.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
