"use client";
// Avertyn — Document library (/library).
// Org-wide search across every case's files and generated filings. Backed by the
// search_org_files RPC (filenames, tags, AI-extracted text, and brief content).
// Each hit links back to its case. Empty query shows the most recent documents.
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

const CAT_LABEL = { filing: "Filing", evidence: "Evidence", correspondence: "Correspondence", contract: "Contract", medical: "Medical", other: "Other" };
const CAT_TONE = { filing: "green", evidence: "grey", correspondence: "amber", contract: "ink", medical: "red", other: "grey" };
const CATS = ["all", "filing", "evidence", "correspondence", "contract", "medical", "other"];

export default function Library() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const deb = useRef(null);

  const run = useCallback(async (query) => {
    setLoading(true); setErr("");
    const { data, error } = await supabase.rpc("search_org_files", { p_query: query || "", p_limit: 80 });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setRows(data || []);
  }, []);

  useEffect(() => { run(""); }, [run]);

  function onQuery(v) {
    setQ(v);
    clearTimeout(deb.current);
    deb.current = setTimeout(() => run(v), 250);
  }

  const shown = cat === "all" ? rows : rows.filter((r) => (r.category || "evidence") === cat);
  const catCounts = rows.reduce((m, r) => { const c = r.category || "evidence"; m[c] = (m[c] || 0) + 1; return m; }, {});

  return (
    <div>
      <div className="topbar"><span className="logo">A</span><b>Avertyn</b>
        <span style={{ color: "#d3cccd", fontSize: 13 }}>· Document library</span></div>
      <div className="wrap" style={{ maxWidth: 1120, margin: "18px auto", padding: "0 22px" }}>
        <Link href="/" className="muted">← Command center</Link>
        <div className="dh" style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1>Document library</h1>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Search every case&apos;s files and filings — by name, tag, party, or anything in the AI-read text.</div>
          </div>
          <input className="dsel" placeholder="Search all documents…" value={q} onChange={(e) => onQuery(e.target.value)}
            autoFocus style={{ padding: "10px 14px", minWidth: 280, fontSize: 14 }} />
        </div>

        {err && <div className="badge b-red" style={{ margin: "10px 0", display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}

        <div className="seg" style={{ margin: "12px 0", flexWrap: "wrap" }}>
          {CATS.filter((c) => c === "all" || catCounts[c]).map((c) => (
            <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
              {c === "all" ? `All (${rows.length})` : `${CAT_LABEL[c]} (${catCounts[c]})`}
            </button>
          ))}
        </div>

        <div className="panel">
          <div className="ph">{q.trim() ? `Results for “${q.trim()}”` : "Most recent documents"}<span className="act"><span className="muted" style={{ fontSize: 11 }}>{shown.length} shown</span></span></div>
          <div className="pb" style={{ paddingTop: 6 }}>
            {loading ? <p className="muted" style={{ padding: 12 }}>Searching…</p>
              : shown.length === 0 ? <p className="muted" style={{ padding: 12 }}>No documents match.</p>
              : shown.map((r) => (
                <div key={r.source + ":" + r.id} className="frow" style={{ alignItems: "flex-start", padding: "12px 4px", borderBottom: "1px solid var(--line)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <b>{r.name}</b>
                      <span className={"badge b-" + (CAT_TONE[r.category] || "grey")}>{CAT_LABEL[r.category] || "Evidence"}</span>
                      <span className="badge b-grey">{r.source === "generated" ? "Filing" : "Upload"}</span>
                      {(r.tags || []).map((t) => <span key={t} className="badge b-grey">#{t}</span>)}
                    </div>
                    {r.snippet && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{r.snippet}{r.snippet.length >= 180 ? "…" : ""}</div>}
                    <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                      Case <Link href={`/dispute/${r.dispute_id}`}>#{r.dispute_ref}</Link>
                      {r.created_at ? " · " + new Date(r.created_at).toLocaleDateString() : ""}
                    </div>
                  </div>
                  <Link className="mini" href={`/dispute/${r.dispute_id}`} style={{ textDecoration: "none", flexShrink: 0 }}>Open case →</Link>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
