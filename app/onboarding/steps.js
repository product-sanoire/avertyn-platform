// Avertyn — onboarding model shared by the /onboarding experience and the
// home "Getting started" launcher. Each step knows how to detect its own
// completion from live signals + stored marks, and which tier requires it.

export const TIERS = [
  { key: "starter", name: "Starter", tag: "Solo & small TPAs",
    blurb: "Everything to defend NSA IDR cases end to end.",
    feats: ["Unlimited cases & the QPA engine", "Brief templates & e-signature", "Document cabinet + redaction", "CMS IDR portal filing"] },
  { key: "pro", name: "Pro", tag: "Growing teams",
    blurb: "Automation, SSO and reporting for busy teams.",
    feats: ["Everything in Starter", "Governed autopilot (the agent)", "SSO & SCIM provisioning", "Scheduled broker / employer reports"] },
  { key: "enterprise", name: "Enterprise", tag: "Large plans & networks",
    blurb: "Scale, control and integrations.",
    feats: ["Everything in Pro", "Dual-control money release", "Custom branding & domains", "API access & integrations"] },
];
export const TIER_RANK = { starter: 0, pro: 1, enterprise: 2 };

// done(signals, marks) -> boolean
export const STEPS = [
  { key: "company", group: "Essentials", tier: "starter", min: 1, kind: "inline", title: "Your organization",
    desc: "Confirm your operator's legal name and type.", done: (s, m) => !!(m.company && m.company.done) },
  { key: "plans", group: "Essentials", tier: "starter", min: 3, kind: "inline", title: "Add your health plans",
    desc: "The plans — and their sponsors — that you administer.", done: (s) => (s.plans || 0) > 0 },
  { key: "team", group: "Essentials", tier: "starter", min: 2, kind: "inline", title: "Invite your team",
    desc: "Add teammates and set their roles.", done: (s, m) => (s.users || 0) > 1 || s.sso || !!(m.team && m.team.done) },
  { key: "registration", group: "Essentials", tier: "starter", min: 5, kind: "confirm", href: "/authorities",
    title: "Register on the CMS IDR portal", cta: "Open registration", confirmLabel: "I've registered",
    desc: "Confirm your Federal IDR portal registration so you can file.", done: (s, m) => !!(m.registration && m.registration.done) },

  { key: "qpa", group: "Get to your first win", tier: "starter", min: 4, kind: "confirm", href: "/?tab=admin",
    title: "Set up your QPA engine", cta: "Open QPA settings", confirmLabel: "QPA is configured",
    desc: "Load contracted rates and confirm CPI-U indexing so QPAs compute correctly.", done: (s, m) => (s.qpa_rates || 0) > 0 || !!(m.qpa && m.qpa.done) },
  { key: "import", group: "Get to your first win", tier: "starter", min: 3, kind: "link", href: "/?open=import",
    title: "Bring in your first cases", cta: "Import cases",
    desc: "Scan an open-negotiation or IDR-initiation notice, or import a CSV.", done: (s) => (s.disputes || 0) > 0 },
  { key: "brief", group: "Get to your first win", tier: "starter", min: 5, kind: "link", href: "/?tab=cases", milestone: true,
    title: "Generate your first brief", cta: "Open a case",
    desc: "Assemble a defense brief on a case — your activation moment.", done: (s) => (s.documents || 0) > 0 },

  { key: "autonomy", group: "Scale up", tier: "pro", min: 2, kind: "confirm", href: "/?tab=cases",
    title: "Set automation guardrails", cta: "Open autonomy dial", confirmLabel: "Guardrails set",
    desc: "Choose what the agent may do on its own, and what needs review.", done: (s, m) => (s.autonomy || 0) > 0 || !!(m.autonomy && m.autonomy.done) },
  { key: "sso", group: "Scale up", tier: "pro", min: 4, kind: "confirm", href: "/?tab=admin",
    title: "Enable single sign-on", cta: "Open access settings", confirmLabel: "SSO enabled",
    desc: "SSO & SCIM auto-provisioning against your identity provider.", done: (s, m) => s.sso || !!(m.sso && m.sso.done) },
  { key: "reports", group: "Scale up", tier: "pro", min: 3, kind: "link", href: "/?tab=admin",
    title: "Schedule reporting", cta: "Create a report",
    desc: "Recurring broker & employer IDR-exposure reports.", done: (s) => (s.reports || 0) > 0 },
  { key: "branding", group: "Scale up", tier: "enterprise", min: 4, kind: "confirm", href: "/?tab=admin",
    title: "Branding & API access", cta: "Open integrations", confirmLabel: "Configured",
    desc: "Custom domains, branding and API keys for your integrations.", done: (s, m) => !!(m.branding && m.branding.done) },
];

export const GROUPS = ["Essentials", "Get to your first win", "Scale up"];

export function stepsForTier(tier) {
  return STEPS.filter((s) => TIER_RANK[s.tier] <= (TIER_RANK[tier] ?? 0));
}
export function marksOf(state) { return (state && state.onboarding && state.onboarding.steps) || {}; }
export function stepDone(step, state) { return !!step.done(state.signals || {}, marksOf(state)); }
export function progressFor(state) {
  const tier = (state && state.tier) || "starter";
  const steps = stepsForTier(tier);
  const doneSteps = steps.filter((st) => stepDone(st, state));
  const remainMin = steps.filter((st) => !stepDone(st, state)).reduce((a, st) => a + (st.min || 3), 0);
  const next = steps.find((st) => !stepDone(st, state)) || null;
  return { total: steps.length, done: doneSteps.length, pct: steps.length ? Math.round(doneSteps.length / steps.length * 100) : 0, steps, remainMin, next };
}
