-- Avertyn — Legal citations + full template coverage
-- Citations verified against eCFR / CMS / Federal Register (2026-07-10). Reflects the
-- CURRENTLY-OPERATIVE Federal IDR framework: QPA is NOT a presumption (TMA-vacated);
-- IDRE must first consider the QPA then weigh the §149.510(c)(4)(iii) factors. No hard
-- batch cap is yet operative (the 50-line cap arrives with the 2026 Operations rule).

-- ── 1. Per-rule authority + one-sentence argument ──────────────────────────
update public.eligibility_rules set
  authority = v.auth, argument = v.arg
from (values
  ('ON_NEG_INCOMPLETE','45 CFR §149.510(b)(1)',
     'The initiating party did not properly send or complete the required 30-business-day open-negotiation period before initiating IDR.'),
  ('TF_INITIATION','45 CFR §149.510(b)(2)(i)',
     'The Notice of IDR Initiation is untimely because it was submitted outside the 4-business-day window that begins on the 31st business day after open negotiation commenced.'),
  ('JUR_STATE','45 CFR §149.510(a)(2); §149.30',
     'A specified State law or All-Payer Model Agreement supplies the method for determining the out-of-network amount, so this item is outside the Federal IDR Process and must be dismissed for lack of federal jurisdiction.'),
  ('QI_NOT_QUALIFIED','45 CFR §149.510(a)(2); §149.420',
     'This service is not a qualified IDR item or service — a valid notice-and-consent waiver applies, or the item is not an emergency or out-of-network-at-participating-facility service — so it is IDR-ineligible.'),
  ('DUP_LINE','45 CFR §149.510(c)(1), (c)(4)',
     'This line item duplicates an item already submitted in an existing or pending dispute and is therefore ineligible under the applicability review.'),
  ('BATCH_CAP','45 CFR §149.510(c)(3)',
     'This batched dispute is improperly constituted because the items do not share the same provider, plan, and similar service code within the same batching window.'),
  ('COST_SHARE','45 CFR §149.120(c)(2); §149.30',
     'Patient cost-sharing was not calculated on the recognized amount (the QPA absent a specified State or All-Payer amount), as the cost-sharing rules require.')
) as v(code, auth, arg)
where eligibility_rules.code = v.code;

-- ── 2. Re-seed the global challenge letter WITH citations ──────────────────
delete from public.document_templates where code = 'challenge_letter' and org_id is null;

with t as (
  insert into public.document_templates (org_id, code, kind, title, description, jurisdiction)
  values (null,'challenge_letter','challenge_letter','Eligibility challenge — {{dispute.external_ref}}',
    'Objects to a Federal IDR dispute''s eligibility, citing each failed eligibility finding to its exact CFR authority. Auto-fills from the case; questions tune tone and optional arguments.','federal')
  returning id)
insert into public.template_questions (template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
select t.id, v.* from t, (values
  (10,'signer_name','Signer name','The person who will sign and submit this objection.','text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title','Appears under the signature.','text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'tone','Tone of the closing','Sets the closing paragraph.','select',
    '[{"value":"firm","label":"Firm — expects dismissal"},{"value":"standard","label":"Standard — cooperative"},{"value":"measured","label":"Measured — open to discussion"}]'::jsonb,
    '"standard"'::jsonb,false,false,null),
  (40,'include_qpa_note','Include alternative QPA note','Adds an in-the-alternative paragraph on the plan''s QPA.','boolean',null,'true'::jsonb,false,false,null),
  (50,'request_closure','Request formal closure','Adds an explicit request that the IDRE close the dispute as ineligible.','boolean',null,'true'::jsonb,false,false,null),
  (60,'cc_initiator','CC the initiating party','Adds a cc line to the initiator.','boolean',null,'false'::jsonb,false,false,null),
  (70,'extra_argument','Additional argument (optional)','Free-text paragraph before the QPA note. Use AI draft to generate from the case facts.','textarea',null,'""'::jsonb,false,true,
    'Write one concise, professional paragraph of additional eligibility argument for a No Surprises Act IDR eligibility objection, grounded only in the supplied dispute facts and failed eligibility findings. Do not invent facts, statutes, or dates. Neutral legal tone.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);

with t as (select id from public.document_templates where code='challenge_letter' and org_id is null)
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, v.* from t, (values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Eligibility objection — Federal IDR Dispute {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity and {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>On behalf of {{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;), we respectfully object to the eligibility of the above-referenced dispute for the Federal Independent Dispute Resolution (IDR) process under the No Surprises Act and 45 CFR §149.510. For the reasons below, this dispute does not satisfy the threshold requirements for Federal IDR and should be dismissed as ineligible.</p>',null,null),
  (40,'grounds_intro','<p>The Plan&rsquo;s objection rests on the following independent ground(s), each with its governing authority:</p>','{"flag":"has_findings"}'::jsonb,null),
  (50,'ground_item','<li><strong>{{this.name}}</strong> <span class="cite">({{this.authority}})</span>. {{this.detail}} {{this.argument}}</li>','{"flag":"has_findings"}'::jsonb,'findings'),
  (55,'no_findings','<p>The Plan is reviewing this dispute for eligibility defects and reserves all rights to supplement this objection. Counsel should confirm the specific grounds and authorities before filing.</p>','{"not":{"flag":"has_findings"}}'::jsonb,null),
  (60,'extra_argument','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}'::jsonb,null),
  (70,'qpa_note','<p>Without waiver of the foregoing eligibility objection, and solely in the alternative, the Plan states that its Qualifying Payment Amount of {{money.qpa}} is the amount the certified IDR entity must first consider under 45 CFR §149.510(c)(4)(iii). The initiating party&rsquo;s demand of {{money.demand}} is not supported when the QPA is weighed against the statutory factors.</p>','{"answer":"include_qpa_note","equals":true}'::jsonb,null),
  (75,'closure','<p>Accordingly, the Plan requests that the certified IDR entity determine this dispute ineligible for the Federal IDR process and close it without proceeding to a payment determination.</p>','{"answer":"request_closure","equals":true}'::jsonb,null),
  (80,'tone_firm','<p>The eligibility defects identified above are dispositive. The Plan expects prompt dismissal and reserves all available remedies for improperly initiated disputes.</p>','{"answer":"tone","equals":"firm"}'::jsonb,null),
  (82,'tone_standard','<p>The Plan appreciates the certified IDR entity&rsquo;s attention to these threshold matters and is available to provide any supporting documentation required.</p>','{"answer":"tone","equals":"standard"}'::jsonb,null),
  (84,'tone_measured','<p>The Plan raises these points to resolve the dispute efficiently and remains open to good-faith discussion consistent with the No Surprises Act.</p>','{"answer":"tone","equals":"measured"}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null),
  (95,'cc','<p class="doc-meta">cc: {{initiator.name}}</p>','{"answer":"cc_initiator","equals":true}'::jsonb,null)
) as v(seq,key,body,include_when,repeat_over);

-- ── 3. Position statement (QPA defense) ────────────────────────────────────
delete from public.document_templates where code = 'position_statement' and org_id is null;

with t as (
  insert into public.document_templates (org_id, code, kind, title, description, jurisdiction)
  values (null,'position_statement','position_statement','Position statement — {{dispute.external_ref}}',
    'Defends the plan''s QPA when a dispute is genuinely eligible: states the QPA, renders the benchmark table, and argues the §149.510(c)(4)(iii) factors.','federal')
  returning id)
insert into public.template_questions (template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
select t.id, v.* from t, (values
  (10,'signer_name','Signer name','Signs the statement.','text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'emphasis','Primary factor to emphasize','Which §149.510(c)(4)(iii) factor to lead with.','select',
    '[{"value":"qpa","label":"QPA + market rates"},{"value":"quality","label":"Quality / complexity"},{"value":"goodfaith","label":"Good-faith network efforts"}]'::jsonb,
    '"qpa"'::jsonb,false,false,null),
  (40,'include_benchmarks','Include benchmark table','Renders the QPA/benchmark comparison table.','boolean',null,'true'::jsonb,false,false,null),
  (50,'extra_argument','Additional argument (optional)','Free-text paragraph. AI draft available.','textarea',null,'""'::jsonb,false,true,
    'Write one concise professional paragraph defending the plan''s QPA as the appropriate out-of-network amount for this NSA IDR item, grounded only in supplied facts. The QPA is NOT a presumption; frame it as the figure the IDRE must first consider under 45 CFR 149.510(c)(4)(iii) before weighing the statutory factors. Do not invent facts.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);

with t as (select id from public.document_templates where code='position_statement' and org_id is null)
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, v.* from t, (values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan position statement — Federal IDR Dispute {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this position statement in support of its offer for the above item and respectfully requests that the certified IDR entity select the Plan&rsquo;s offer at or near the Qualifying Payment Amount (QPA).</p>',null,null),
  (40,'standard','<p>Under 45 CFR §149.510(c)(4)(iii), the certified IDR entity must first consider the QPA for the same or similar item and then weigh the additional statutory factors. No single factor, including the QPA, is controlling; the Plan&rsquo;s position is that, properly weighed, those factors support the QPA.</p>',null,null),
  (50,'qpa_para','<p>The Plan&rsquo;s QPA for this item is {{money.qpa}}, determined using the {{qpa.methodology}}. The initiating party&rsquo;s demand of {{money.demand}} reflects billed charges rather than the recognized market rate.</p>',null,null),
  (60,'benchmarks','<p>The QPA is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}'::jsonb,null),
  (70,'factor_qpa','<p>The QPA reflects the median of the Plan&rsquo;s contracted rates for this service in the geographic market and is the best evidence of the market rate; the additional factors do not justify a departure upward.</p>','{"answer":"emphasis","equals":"qpa"}'::jsonb,null),
  (72,'factor_quality','<p>The acuity, complexity, and quality considerations for this item are already reflected in the QPA and the service coding; nothing in the record warrants a rate above the QPA on quality grounds.</p>','{"answer":"emphasis","equals":"quality"}'::jsonb,null),
  (74,'factor_goodfaith','<p>The Plan has made good-faith efforts to contract with providers of this service at market rates; the initiating party&rsquo;s decision to remain out-of-network does not support a rate above the QPA.</p>','{"answer":"emphasis","equals":"goodfaith"}'::jsonb,null),
  (80,'extra_argument','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}'::jsonb,null),
  (90,'request','<p>For these reasons, the Plan respectfully requests that the certified IDR entity select the Plan&rsquo;s offer at or near the QPA of {{money.qpa}}.</p>',null,null),
  (95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ── 4. Open-negotiation notice ─────────────────────────────────────────────
delete from public.document_templates where code = 'open_negotiation' and org_id is null;

with t as (
  insert into public.document_templates (org_id, code, kind, title, description, jurisdiction)
  values (null,'open_negotiation','open_negotiation','Open-negotiation notice — {{dispute.external_ref}}',
    'Initiates the 30-business-day open-negotiation period under §149.510(b)(1) with a good-faith offer.','federal')
  returning id)
insert into public.template_questions (template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
select t.id, v.* from t, (values
  (10,'signer_name','Signer name','Signs the notice.','text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'offer_amount','Good-faith offer','Defaults to the plan QPA if left blank.','text',null,'""'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);

with t as (select id from public.document_templates where code='open_negotiation' and org_id is null)
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, v.* from t, (values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Open-negotiation notice — {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',null::jsonb,null::text),
  (20,'intro','<p>Pursuant to the No Surprises Act and 45 CFR §149.510(b)(1), {{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) initiates the 30-business-day open-negotiation period for the above out-of-network item with {{initiator.name}}.</p>',null,null),
  (30,'offer_qpa','<p>The Plan&rsquo;s good-faith offer is its Qualifying Payment Amount of {{money.qpa}}.</p>','{"not":{"answer":"offer_amount"}}'::jsonb,null),
  (35,'offer_custom','<p>The Plan&rsquo;s good-faith offer is {{answers.offer_amount}}.</p>','{"answer":"offer_amount"}'::jsonb,null),
  (40,'timing','<p>The Plan requests a response during the open-negotiation period. If the parties do not reach agreement within 30 business days, either party may initiate Federal IDR within the 4-business-day window that begins on the 31st business day (§149.510(b)(2)(i)).</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ── 5. Settlement / offer letter ───────────────────────────────────────────
delete from public.document_templates where code = 'offer_letter' and org_id is null;

with t as (
  insert into public.document_templates (org_id, code, kind, title, description, jurisdiction)
  values (null,'offer_letter','offer_letter','Settlement offer — {{dispute.external_ref}}',
    'Proposes a negotiated resolution to the initiating party at a stated amount, open for a set period.','federal')
  returning id)
insert into public.template_questions (template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
select t.id, v.* from t, (values
  (10,'signer_name','Signer name','Signs the offer.','text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'offer_amount','Offer amount','The settlement figure, e.g. $650.','text',null,'""'::jsonb,true,false,null),
  (40,'open_days','Offer open for (days)',null,'text',null,'"10"'::jsonb,false,false,null),
  (50,'rationale','Rationale (optional)','Why this figure is fair. AI draft available.','textarea',null,'""'::jsonb,false,true,
    'Write one concise professional paragraph explaining why the stated settlement figure is a fair resolution of this NSA out-of-network dispute, grounded only in supplied facts (QPA, demand, benchmarks). Do not invent facts. Non-admission, without-prejudice tone.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);

with t as (select id from public.document_templates where code='offer_letter' and org_id is null)
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, v.* from t, (values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Settlement offer — {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>To {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>Without admission of liability and without prejudice to its position, {{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) offers to resolve the above out-of-network item on the following terms.</p>',null,null),
  (40,'offer','<p>The Plan offers <strong>{{answers.offer_amount}}</strong> in full and final settlement of this item (Plan QPA {{money.qpa}}; demand {{money.demand}}).</p>',null,null),
  (50,'rationale','<p>{{answers.rationale}}</p>','{"answer":"rationale"}'::jsonb,null),
  (60,'terms','<p>This offer remains open for {{answers.open_days}} days from the date above. Acceptance resolves the item in full and, where applicable, is submitted to close any pending Federal IDR proceeding.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);
