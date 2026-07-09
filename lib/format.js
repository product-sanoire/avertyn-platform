export const money = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

// Business-ish countdown label from a timestamp.
export function untilLabel(ts) {
  if (!ts) return "—";
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return "overdue";
  const h = Math.floor(ms / 3.6e6);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Map a dispute to Avertyn's "read" (recommended posture).
export function avertynRead(d) {
  if (d.disposition === "provider_win") return { label: "Award — pay", tone: "ind" };
  if (d.eligibility_score >= 80) return { label: "Likely ineligible", tone: "red" };
  if (d.eligibility_score >= 60) return { label: "Review eligibility", tone: "amber" };
  if (d.workflow_state === "qpa_defense") return { label: "Defend QPA", tone: "ind" };
  return { label: "Defensible", tone: "green" };
}
