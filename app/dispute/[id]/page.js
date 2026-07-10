"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "../../../lib/supabaseClient";
import { money, untilLabel } from "../../../lib/format";
import IdrPanel from "./IdrPanel";
import Composer from "./Composer";
import Claims from "./Claims";

const mark = { pass: ["ok", "✓"], fail: ["no", "×"], warn: ["warn", "!"], na: ["grey", "–"] };

// Brief lifecycle status (mirrors the Composer): draft -> in review -> approved -> filed.
const DOC_STATUS_LABEL = { draft: "Draft", in_review: "In review", approved: "Approved", filed: "Filed" };
const DOC_STATUS_TONE = { draft: "grey", in_review: "amber", approved: "green", filed: "ink" };
const DOC_STATUS_RANK = { draft: 1, in_review: 2, approved: 3, filed: 4 };
const briefStatusOf = (docs) => {
  if (!docs || !docs.length) return null;
  let best = "draft", rank = 0;
  for (const dc of docs) { const r = DOC_STATUS_RANK[dc.status] || 1; if (r >= rank) { rank = r; best = dc.status || "draft"; } }
  return best;
};

export default function CaseWorkspace() {
  const router = useRouter();
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState(null);
  const [findings, setFindings] = useState([]);
  const [qpa, setQpa] = useState(null);
  const [offers, setOffers] = useState([]);
  const [deadlines, setDeadlines] = useState([]);
  const [briefDocs, setBriefDocs] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { router.push("/login"); return; }

    const [{ data: disp }, { data: fnd }, { data: q }, { data: off }, { data: dl }, { data: docs }] = await Promise.all([
      supabase.from("disputes")
        .select("*, plans(name), employers(name), initiators(name)").eq("id", id).single(),
      supabase.from("eligibility_findings")
        .select("result, confidence, detail, eligibility_rules(name, code, severity, category)")
        .eq("dispute_id", id),
      supabase.from("qpa_records").select("*").eq("dispute_id", id).maybeSingle(),
      supabase.from("offers").select("*").eq("dispute_id", id).order("submitted_at"),
      supabase.from("deadlines").select("*").eq("dispute_id", id).order("due_at"),
      supabase.from("documents").select("status, esign_status").eq("dispute_id", id),
    ]);
    setD(disp || null); setFindings(fnd || []); setQpa(q || null);
    setOffers(off || []); setDeadlines(dl || []); setBriefDocs(docs || []); setLoading(false);
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  async function runEngine() {
    setBusy(true);
    await supabase.rpc("run_eligibility", { p_dispute: id });
    await load();
    setBusy(false);
  }

  if (loading) return <Shell><p className="muted">Loading case…</p></Shell>;
  if (!d) return <Shell><p className="muted">Case not found (or hidden by RLS).</p></Shell>;

  const score = d.eligibility_score ?? 0;
  const tone = score >= 80 ? "red" : score >= 60 ? "amber" : "green";
  const verdict = score >= 80 ? "Challenge — likely ineligible"
    : score >= 60 ? "Review eligibility" : "Defensible — go to QPA defense";

  return (
    <Shell>
      <div className="wrap">
        <Link href="/dashboard" className="muted">← Command center</Link>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 28, margin: 0 }}>#{d.external_ref}</h1>
          {(() => {
            const idr = d.phase === "idr";
            const lead = idr
              ? (d.idr_registration_number ? "Dispute No. " + d.idr_registration_number : null)
              : (d.claim_number ? "Claim #" + d.claim_number : null);
            return (
              <>
                <span className={"badge b-" + (idr ? "green" : "amber")} title="Case phase">
                  <i className={"dot d-" + (idr ? "green" : "amber")} />{idr ? "Federal IDR" : "Open negotiation"}
                </span>
                {lead && <span className="badge b-ink" style={{ fontFamily: "var(--num,inherit)" }}>{lead}</span>}
              </>
            );
          })()}
          <span className="muted">
            {d.initiators?.name} · CPT {d.cpt_code} · {d.plans?.name} · {d.service_category}
          </span>
          {briefDocs.length > 0 && (
            <span className={"badge b-" + (DOC_STATUS_TONE[briefStatusOf(briefDocs)] || "grey")}
              title={`Furthest-along brief status across ${briefDocs.length} document${briefDocs.length === 1 ? "" : "s"} on this case`}>
              <i className={"dot d-" + (DOC_STATUS_TONE[briefStatusOf(briefDocs)] || "grey")} />
              Brief: {DOC_STATUS_LABEL[briefStatusOf(briefDocs)] || "Draft"}
            </span>
          )}
          {briefDocs.some((x) => x.esign_status === "signed") && (
            <span className="badge b-green"><i className="dot d-green" />Sealed</span>
          )}
        </div>

        {/* Banner */}
        <div style={{ display: "flex", gap: 14, marginTop: 16, flexWrap: "wrap" }}>
          <Box>
            <div className="muted" style={{ fontSize: 12 }}>Ineligibility score</div>
            <div style={{ fontSize: 30, fontWeight: 700 }} className="mono">{score}</div>
            <span className={"badge b-" + tone}>{verdict}</span>
          </Box>
          <Box>
            <div className="muted" style={{ fontSize: 12 }}>Demand vs QPA</div>
            <div style={{ fontSize: 30, fontWeight: 700 }} className="mono">{money(d.demand_amount)}</div>
            <div className="muted" style={{ fontSize: 12 }}>QPA {money(d.qpa_amount)}</div>
          </Box>
          <Box>
            <div className="muted" style={{ fontSize: 12 }}>Respond by</div>
            <div style={{ fontSize: 30, fontWeight: 700 }} className="mono">
              {d.respond_by ? untilLabel(d.respond_by) : "—"}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>State: {d.workflow_state}</div>
          </Box>
        </div>

        {/* Claims & identifiers */}
        <Claims disputeId={id} dispute={d} onIdentifiers={load} />

        {/* Eligibility */}
        <Panel title="Eligibility findings"
          action={<button className="mini" onClick={runEngine} disabled={busy}>{busy ? "Running…" : "Run engine"}</button>}>
          {findings.length === 0 ? <Empty text="No findings yet — run the engine." /> :
            findings.map((f, i) => {
              const [cls, gl] = mark[f.result] || mark.na;
              return (
                <div key={i} style={row}>
                  <span className={"mk " + cls}>{gl}</span>
                  <div>
                    <b>{f.eligibility_rules?.name}</b>
                    <span className="muted" style={{ display: "block", fontSize: 12.5 }}>
                      {f.eligibility_rules?.severity} · {f.detail}
                    </span>
                  </div>
                </div>
              );
            })}
        </Panel>

        {/* QPA */}
        <Panel title="QPA defense">
          {!qpa ? <Empty text="No QPA record for this case." /> : (
            <div>
              <Bar label="Demand" val={d.demand_amount} max={d.demand_amount} color="var(--red)" />
              <Bar label="Plan QPA" val={qpa.plan_qpa} max={d.demand_amount} color="var(--ind)" />
              <Bar label="FAIR Health median" val={qpa.benchmark_fairhealth} max={d.demand_amount} color="var(--gold)" />
              <Bar label="Defensible ceiling" val={qpa.defensible_ceiling} max={d.demand_amount} color="var(--navy)" />
              {qpa.notes && <p className="muted" style={{ fontSize: 13 }}>{qpa.notes}</p>}
            </div>
          )}
        </Panel>

        {/* Offers */}
        <Panel title="Offers & negotiation">
          {offers.length === 0 ? <Empty text="No offers logged." /> :
            offers.map((o) => (
              <div key={o.id} style={row}>
                <span className={"badge " + (o.party === "plan" ? "b-ind" : "b-amber")}>{o.party}</span>
                <div><b className="mono">{money(o.amount)}</b>
                  <span className="muted" style={{ display: "block", fontSize: 12.5 }}>{o.kind} · {o.note}</span>
                </div>
              </div>
            ))}
        </Panel>

        {/* Deadlines */}
        <Panel title="Deadlines">
          {deadlines.length === 0 ? <Empty text="No tracked windows." /> :
            deadlines.map((dl) => (
              <div key={dl.id} style={row}>
                <span className="badge b-grey">{dl.kind}</span>
                <div><b>{untilLabel(dl.due_at)}</b>
                  <span className="muted" style={{ display: "block", fontSize: 12.5 }}>
                    due {new Date(dl.due_at).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
        </Panel>

        {/* Argument documents — template-driven, editable, e-signable */}
        <Panel title="Documents">
          <Composer dispute={d} />
        </Panel>

        {/* CMS Federal IDR Gateway — connector panel */}
        <IdrPanel dispute={d} />
      </div>
    </Shell>
  );
}

const row = { display: "flex", gap: 11, alignItems: "flex-start", padding: "11px 0", borderBottom: "1px solid var(--line)" };

function Shell({ children }) {
  return (
    <div>
      <div className="topbar"><span className="logo">B</span><b>Avertyn</b>
        <span style={{ color: "#d3cccd", fontSize: 13 }}>· Case workspace</span></div>
      {children}
    </div>
  );
}
function Box({ children }) {
  return <div style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: "14px 16px", minWidth: 180 }}>{children}</div>;
}
function Panel({ title, action, children }) {
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="ph" style={{ display: "flex", alignItems: "center" }}>
        <span>{title}</span><span style={{ flex: 1 }} />{action}
      </div>
      <div style={{ padding: "6px 16px 12px" }}>{children}</div>
    </div>
  );
}
function Empty({ text }) { return <p className="muted" style={{ padding: "10px 0" }}>{text}</p>; }
function Bar({ label, val, max, color }) {
  const pct = max ? Math.min(100, Math.round((Number(val) / Number(max)) * 100)) : 0;
  return (
    <div style={{ margin: "12px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
        <b>{label}</b><span className="mono">{money(val)}</span>
      </div>
      <div style={{ height: 12, background: "#f1edee", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ height: "100%", width: pct + "%", background: color, borderRadius: 8 }} />
      </div>
    </div>
  );
}
