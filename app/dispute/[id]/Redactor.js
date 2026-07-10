"use client";
// Avertyn — Redactor.
// True burn-in redaction for case files. Renders each PDF/image page to a canvas,
// lets Claude propose PHI/PII boxes (located via the PDF text layer) and lets you draw
// your own, then FLATTENS each page to a raster and rebuilds a new PDF — the redacted
// regions are permanently removed (the underlying text/image data is gone, not covered).
// pdf.js + jsPDF are loaded from CDN at runtime (no build dependency).
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "../../../lib/supabaseClient";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const RENDER_SCALE = 2;      // rasterize at 2x for crisp burn-in
const MAX_PAGES = 25;
const TYPE_LABEL = { name: "Name", mrn: "MRN", ssn: "SSN", dob: "DOB", address: "Address", phone: "Phone", email: "Email", account: "Account", pii: "PII" };

function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some((s) => s.src === src)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("Failed to load " + src));
    document.body.appendChild(s);
  });
}

export default function Redactor({ file, disputeId, orgId, onClose, onSaved }) {
  const [pages, setPages] = useState([]);        // [{canvas, wpt, hpt, w, h}]
  const [boxes, setBoxes] = useState([]);        // [{id, page, x, y, w, h, source, label}]
  const [loading, setLoading] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const pdfRef = useRef(null);                    // pdf.js document (for text layer)
  const drawRef = useRef(null);                   // in-progress manual box
  const idRef = useRef(1);

  // ---- load + render the document ----
  const render = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      await loadScript(PDFJS);
      const pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

      const { data: signed, error: se } = await supabase.storage.from("evidence").createSignedUrl(file.storage_path, 600);
      if (se || !signed?.signedUrl) throw new Error("Could not open the file.");
      const bytes = new Uint8Array(await (await fetch(signed.signedUrl)).arrayBuffer());
      const isPdf = (file.mime || "").includes("pdf") || (file.name || file.filename || "").toLowerCase().endsWith(".pdf");

      const out = [];
      if (isPdf) {
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        pdfRef.current = pdf;
        const n = Math.min(pdf.numPages, MAX_PAGES);
        for (let i = 1; i <= n; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: RENDER_SCALE });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
          const base = page.getViewport({ scale: 1 });
          out.push({ canvas, url: canvas.toDataURL("image/png"), wpt: base.width, hpt: base.height, w: vp.width, h: vp.height });
        }
      } else {
        // image
        const url = URL.createObjectURL(new Blob([bytes], { type: file.mime || "image/png" }));
        const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        out.push({ canvas, url: canvas.toDataURL("image/png"), wpt: img.naturalWidth, hpt: img.naturalHeight, w: img.naturalWidth, h: img.naturalHeight });
      }
      setPages(out);
    } catch (e) { setErr("Could not render this document: " + (e.message || e)); }
    setLoading(false);
  }, [file]);

  useEffect(() => { render(); }, [render]);

  // ---- AI detect PHI/PII, then locate on the page via the text layer ----
  async function aiDetect() {
    setAiBusy(true); setErr(""); setNote("");
    try {
      const { data, error } = await supabase.functions.invoke("redact-scan", { body: { evidence_id: file.id } });
      if (error) throw error;
      if (!data?.ok) { setErr(data?.reason || "AI redaction is unavailable."); setAiBusy(false); return; }
      const items = (data.items || []).filter((it) => (it.text || "").trim().length >= 2);
      if (!items.length) { setNote("Claude found no PHI/PII to redact. Add boxes manually if needed."); setAiBusy(false); return; }

      const found = [];
      const pdf = pdfRef.current;
      if (pdf) {
        const pdfjsLib = window.pdfjsLib;
        const n = Math.min(pdf.numPages, MAX_PAGES);
        for (let p = 1; p <= n; p++) {
          const page = await pdf.getPage(p);
          const vp = page.getViewport({ scale: RENDER_SCALE });
          const tc = await page.getTextContent();
          for (const t of tc.items) {
            const s = (t.str || "").trim();
            if (s.length < 2) continue;
            const hit = items.find((it) => {
              const a = it.text.toLowerCase(), b = s.toLowerCase();
              return b.includes(a) || (a.length >= 4 && a.includes(b));
            });
            if (!hit) continue;
            const tr = pdfjsLib.Util.transform(vp.transform, t.transform);
            const fh = Math.hypot(tr[2], tr[3]) || 12;
            const w = (t.width || s.length * 4) * vp.scale;
            found.push({ id: idRef.current++, page: p - 1, x: tr[4] - 2, y: tr[5] - fh - 2, w: w + 4, h: fh + 4, source: "ai", label: TYPE_LABEL[hit.type] || "PII" });
          }
        }
      }
      // Drop AI boxes that duplicate an existing one heavily
      setBoxes((prev) => {
        const merged = [...prev];
        for (const b of found) {
          if (!merged.some((m) => m.page === b.page && Math.abs(m.x - b.x) < 6 && Math.abs(m.y - b.y) < 6)) merged.push(b);
        }
        return merged;
      });
      const locatable = found.length;
      setNote(pdf
        ? `Claude flagged ${items.length} item${items.length === 1 ? "" : "s"}; placed ${locatable} box${locatable === 1 ? "" : "es"} on the page. Review, adjust, or add your own, then Apply.`
        : `Claude flagged ${items.length} item${items.length === 1 ? "" : "s"}. This is an image (no text layer) — draw boxes over them, then Apply.`);
    } catch (e) { setErr("AI detect failed: " + (e.message || e)); }
    setAiBusy(false);
  }

  // ---- manual box drawing (coords are in render-canvas pixels) ----
  function pagePointer(pi, dispW) {
    const scale = pages[pi].w / dispW;    // render px per display px
    return {
      onPointerDown: (e) => {
        if (applying) return;
        const r = e.currentTarget.getBoundingClientRect();
        drawRef.current = { pi, x0: (e.clientX - r.left) * scale, y0: (e.clientY - r.top) * scale };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e) => {
        const d = drawRef.current; if (!d || d.pi !== pi) return;
        const r = e.currentTarget.getBoundingClientRect();
        const x1 = (e.clientX - r.left) * scale, y1 = (e.clientY - r.top) * scale;
        setBoxes((prev) => {
          const rest = prev.filter((b) => b.id !== -1);
          return [...rest, { id: -1, page: pi, x: Math.min(d.x0, x1), y: Math.min(d.y0, y1), w: Math.abs(x1 - d.x0), h: Math.abs(y1 - d.y0), source: "manual", label: "Manual" }];
        });
      },
      onPointerUp: () => {
        const d = drawRef.current; drawRef.current = null;
        setBoxes((prev) => prev.map((b) => (b.id === -1 ? (b.w > 4 && b.h > 4 ? { ...b, id: idRef.current++ } : null) : b)).filter(Boolean));
      },
    };
  }
  const removeBox = (id) => setBoxes((prev) => prev.filter((b) => b.id !== id));

  // ---- apply: flatten each page + boxes to raster, rebuild a PDF, upload ----
  async function apply() {
    if (!boxes.length) { setErr("Add at least one redaction box first."); return; }
    setApplying(true); setErr("");
    try {
      await loadScript(JSPDF);
      const { jsPDF } = window.jspdf;
      let doc = null;
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        const tmp = document.createElement("canvas");
        tmp.width = pg.canvas.width; tmp.height = pg.canvas.height;
        const ctx = tmp.getContext("2d");
        ctx.drawImage(pg.canvas, 0, 0);
        ctx.fillStyle = "#000";
        boxes.filter((b) => b.page === i).forEach((b) => ctx.fillRect(b.x, b.y, b.w, b.h));
        const img = tmp.toDataURL("image/jpeg", 0.85);
        const orient = pg.wpt >= pg.hpt ? "landscape" : "portrait";
        if (!doc) doc = new jsPDF({ unit: "pt", format: [pg.wpt, pg.hpt], orientation: orient });
        else doc.addPage([pg.wpt, pg.hpt], orient);
        doc.addImage(img, "JPEG", 0, 0, pg.wpt, pg.hpt);
      }
      const blob = doc.output("blob");
      const base = (file.name || file.filename || "document").replace(/\.[^.]+$/, "");
      const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const path = `${orgId}/${disputeId}/${crypto.randomUUID()}-${safe}-redacted.pdf`;
      const up = await supabase.storage.from("evidence").upload(path, blob, { contentType: "application/pdf" });
      if (up.error) throw up.error;
      const { data: evId, error: ae } = await supabase.rpc("add_evidence", {
        p_dispute: disputeId, p_path: path, p_filename: base + " (redacted).pdf", p_mime: "application/pdf", p_size: blob.size });
      if (ae) throw ae;
      try { await supabase.rpc("set_file_meta", { p_id: evId, p_category: file.category || "evidence", p_tags: ["redacted"] }); } catch (_) { /* tag is best-effort */ }
      onSaved && onSaved();
    } catch (e) { setErr("Could not build the redacted file: " + (e.message || e)); }
    setApplying(false);
  }

  const total = boxes.filter((b) => b.id !== -1).length;

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget && !applying) onClose && onClose(); }}>
      <div style={panel}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
          <b style={{ fontFamily: "var(--disp,serif)", fontSize: 16 }}>Redact — {file.name || file.filename}</b>
          <span className="muted" style={{ fontSize: 12 }}>{total} box{total === 1 ? "" : "es"} · true burn-in</span>
          <span style={{ flex: 1 }} />
          <button className="mini" disabled={aiBusy || loading} onClick={aiDetect}>{aiBusy ? "Detecting…" : "✦ AI detect PHI/PII"}</button>
          <button className="mini" disabled={!boxes.length || applying} onClick={() => setBoxes([])}>Clear</button>
          <button className="btn btn-a" disabled={applying || !boxes.length} onClick={apply} style={{ padding: "7px 14px" }}>{applying ? "Redacting…" : "Apply & save redacted copy →"}</button>
          <button className="mini" disabled={applying} onClick={() => onClose && onClose()}>Close</button>
        </div>

        {err && <div className="badge b-red" style={{ margin: "10px 18px", display: "inline-flex", gap: 8 }}><i className="dot d-red" />{err}</div>}
        {note && !err && <div className="muted" style={{ margin: "8px 18px", fontSize: 12.5 }}>{note}</div>}

        <div style={{ overflow: "auto", padding: "14px 18px", background: "var(--sunk,#f4f1ec)" }}>
          {loading ? <p className="muted">Rendering document…</p>
            : pages.length === 0 ? <p className="muted">Nothing to show.</p>
            : pages.map((pg, i) => {
              const dispW = Math.min(820, pg.w);
              const dispH = pg.h * (dispW / pg.w);
              const handlers = pagePointer(i, dispW);
              return (
                <div key={i} style={{ position: "relative", width: dispW, margin: "0 auto 16px", boxShadow: "0 1px 6px rgba(0,0,0,.15)", touchAction: "none", cursor: "crosshair" }}
                  {...handlers}>
                  <img src={pg.url} width={dispW} height={dispH} style={{ display: "block", userSelect: "none", pointerEvents: "none" }} alt={"Page " + (i + 1)} />
                  {boxes.filter((b) => b.page === i).map((b) => {
                    const k = dispW / pg.w;
                    return (
                      <div key={b.id} onClick={(e) => { e.stopPropagation(); if (b.id !== -1) removeBox(b.id); }}
                        title={b.source === "ai" ? `${b.label} (AI) — click to remove` : "Manual — click to remove"}
                        style={{ position: "absolute", left: b.x * k, top: b.y * k, width: b.w * k, height: b.h * k,
                          background: b.source === "ai" ? "rgba(178,58,32,.55)" : "rgba(20,20,20,.72)",
                          border: b.source === "ai" ? "1.5px solid #b23a20" : "1.5px solid #141414", cursor: "pointer" }} />
                    );
                  })}
                </div>
              );
            })}
        </div>

        <div className="muted" style={{ padding: "10px 18px", fontSize: 11.5, borderTop: "1px solid var(--line)" }}>
          Draw a box over anything to redact; click a box to remove it. Red = AI-proposed, dark = manual. Apply rasterizes each page and rebuilds the PDF, so redacted content is permanently removed — then saves a “(redacted)” copy to Case files.
        </div>
      </div>
    </div>
  );
}

const overlay = { position: "fixed", inset: 0, background: "rgba(20,18,16,.55)", zIndex: 90, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflow: "auto" };
const panel = { background: "var(--card,#fff)", borderRadius: 14, width: "min(960px,96vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 12px 48px rgba(0,0,0,.3)" };
