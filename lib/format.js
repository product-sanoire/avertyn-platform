export const money = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

// Count business days (Mon–Fri) between now and a target timestamp.
// Note: federal-holiday awareness lives server-side (federal_holidays table);
// this client label excludes weekends so it reads in business-day terms to
// match the product's "business-day, holiday-aware" deadline promise.
function businessDaysUntil(target) {
  const end = new Date(target);
  const now = new Date();
  if (end <= now) return -1;
  let days = 0;
  const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur < last) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

// Business-day countdown label from a timestamp.
export function untilLabel(ts) {
  if (!ts) return "—";
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return "overdue";
  const h = Math.floor(ms / 3.6e6);
  if (h < 24) return `${h}h`;
  const bd = businessDaysUntil(ts);
  return bd <= 0 ? "next biz day" : `${bd} biz day${bd === 1 ? "" : "s"}`;
}

// Map a dispute to Avertyn's "read" (recommended posture). Tones map to
// defined badge/dot classes: red · amber · green · ink.
export function avertynRead(d) {
  if (d.disposition === "provider_win") return { label: "Award — pay", tone: "ink" };
  if (d.eligibility_score >= 80) return { label: "Likely ineligible", tone: "red" };
  if (d.eligibility_score >= 60) return { label: "Review eligibility", tone: "amber" };
  if (d.workflow_state === "qpa_defense") return { label: "Defend QPA", tone: "ink" };
  return { label: "Defensible", tone: "green" };
}

// The legal case identifier is primary and phase-dependent:
//   • Federal IDR phase        → the IDR dispute number (one number covers the whole batch)
//   • Open negotiation, 1 claim → the claim number
//   • Open negotiation, batched → NO single claim number exists, so anchor on the internal case
//                                 ref and label it "Batch · N claims" (the batch is the unit)
// The operator's own external_ref is the permanent internal anchor that never changes across phases.
// Claim count can come from opts.claimCount, d.claim_count, or an embedded claims(count) select.
export function caseIdentity(d, opts = {}) {
  if (!d) return { number: "—", label: "Case", isLegal: false, isBatch: false, internal: "" };
  const idr = d.phase === "idr";
  const legal = ((idr ? d.idr_registration_number : d.claim_number) || "").trim();
  const internal = (d.external_ref || "").trim();
  const claimCount =
    opts.claimCount ?? d.claim_count ??
    (Array.isArray(d.claims) ? (d.claims[0]?.count ?? d.claims.length) : 0) ?? 0;

  if (!idr && claimCount > 1) {
    return {
      number: internal || legal || "—",   // anchor identifier for lists
      label: `Batch · ${claimCount} claims`,
      isLegal: false, isBatch: true, claimCount, leadClaim: legal || null,
      phaseIdr: false, internal,
    };
  }
  return {
    number: legal || internal || "—",
    label: idr ? "Dispute No." : (legal ? "Claim No." : "Case"),
    isLegal: !!legal, isBatch: false, claimCount, phaseIdr: idr, internal,
  };
}
