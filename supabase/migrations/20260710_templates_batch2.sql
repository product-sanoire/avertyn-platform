-- Avertyn — Argument templates, batch 2 (completes the plan/TPA-side IDR loop)
-- Citations reflect the currently-operative Federal IDR framework (45 CFR part 149).
-- Re-runnable: each template's global copy is replaced in place.
-- NOTE: {{CITE_*}} markers are finalized against verified subsections before apply.

-- Reusable pattern per template:
--   delete global copy → insert template (returns id) → insert questions → insert clauses

-- ═══ 1. Response to Notice of IDR Initiation ═══════════════════════════════
delete from public.document_templates where code='idr_initiation_response' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'idr_initiation_response','idr_initiation_response','Response to IDR initiation — {{dispute.external_ref}}',
  'The plan''s formal response to a provider''s Notice of IDR Initiation: reserves eligibility objections and states the plan''s offer.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'reserve_eligibility','Reserve eligibility objections','Adds a paragraph preserving any eligibility challenge.','boolean',null,'true'::jsonb,false,false,null),
  (40,'offer_amount','Plan offer','Defaults to the plan QPA if blank.','text',null,'""'::jsonb,false,false,null),
  (50,'extra_argument','Additional argument (optional)',null,'textarea',null,'""'::jsonb,false,true,
     'Write one concise professional paragraph for a plan''s response to a No Surprises Act IDR Notice of Initiation, grounded only in the supplied facts. Do not invent facts.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='idr_initiation_response' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Response to Notice of IDR Initiation — Federal IDR Dispute {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity and {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) acknowledges receipt of the Notice of IDR Initiation for the above item and submits this response in the Federal Independent Dispute Resolution process under 45 CFR §149.510.</p>',null,null),
  (40,'reserve','<p>The Plan expressly reserves and renews all objections to the eligibility of this dispute for the Federal IDR process, including any defect in open negotiation, timeliness, jurisdiction, or the qualified status of the item, and requests that eligibility be resolved before any payment determination.</p>','{"answer":"reserve_eligibility","equals":true}'::jsonb,null),
  (50,'offer_qpa','<p>Subject to and without waiver of the foregoing, the Plan''s offer for this item is its Qualifying Payment Amount of {{money.qpa}}, which the certified IDR entity must first consider under 45 CFR §149.510(c)(4)(iii).</p>','{"not":{"answer":"offer_amount"}}'::jsonb,null),
  (55,'offer_custom','<p>Subject to and without waiver of the foregoing, the Plan''s offer for this item is {{answers.offer_amount}}.</p>','{"answer":"offer_amount"}'::jsonb,null),
  (60,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}'::jsonb,null),
  (88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 2. Certified IDRE conflict-of-interest objection ══════════════════════
delete from public.document_templates where code='idre_conflict_objection' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'idre_conflict_objection','idre_conflict_objection','IDRE conflict objection — {{dispute.external_ref}}',
  'Objects to a selected certified IDR entity on conflict-of-interest grounds and requests reselection.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'idre_name','Certified IDR entity objected to',null,'text',null,'""'::jsonb,true,false,null),
  (40,'conflict_basis','Basis for the conflict','Describe the conflict of interest.','textarea',null,'""'::jsonb,false,true,
     'Write one concise professional paragraph stating a good-faith basis to object to a certified IDR entity on conflict-of-interest grounds in a No Surprises Act dispute, grounded only in the supplied facts. Do not invent facts.'),
  (50,'request_reselection','Request reselection','Requests a conflict-free entity be selected.','boolean',null,'true'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='idre_conflict_objection' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Objection to certified IDR entity selection — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Departments and the certified IDR entity selection administrator:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) objects to the selection of {{answers.idre_name}} as the certified IDR entity for the above dispute on conflict-of-interest grounds, consistent with the certified IDR entity conflict-of-interest requirements under 45 CFR §149.510.</p>',null,null),
  (40,'basis','<p>{{answers.conflict_basis}}</p>','{"answer":"conflict_basis"}'::jsonb,null),
  (50,'request','<p>The Plan respectfully requests that {{answers.idre_name}} be removed from this dispute and that a certified IDR entity without a disqualifying conflict be selected.</p>','{"answer":"request_reselection","equals":true}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 3. Extension / good-cause request ═════════════════════════════════════
delete from public.document_templates where code='extension_request' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'extension_request','extension_request','Extension request — {{dispute.external_ref}}',
  'Requests additional time on an IDR deadline for good cause / extenuating circumstances.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'deadline_type','Deadline to extend',null,'select',
     '[{"value":"the response","label":"Response deadline"},{"value":"the offer submission","label":"Offer submission"},{"value":"the document submission","label":"Document submission"},{"value":"the payment","label":"Payment window"}]'::jsonb,
     '"the response"'::jsonb,false,false,null),
  (40,'extra_days','Additional business days',null,'text',null,'"5"'::jsonb,false,false,null),
  (50,'reason','Reason / extenuating circumstances',null,'textarea',null,'""'::jsonb,false,true,
     'Write one concise professional sentence or two giving a good-faith extenuating-circumstances reason to request an IDR deadline extension, grounded only in supplied facts. Do not invent facts.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='extension_request' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Request for extension — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) respectfully requests {{answers.extra_days}} additional business days on {{answers.deadline_type}} deadline for the above dispute for good cause.</p>',null,null),
  (40,'reason','<p>{{answers.reason}}</p>','{"answer":"reason"}'::jsonb,null),
  (50,'close','<p>Granting this request will allow the Plan to submit a complete and accurate record and will not prejudice any party.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 4. Response to IDRE request for information ═══════════════════════════
delete from public.document_templates where code='idre_info_response' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'idre_info_response','idre_info_response','IDRE information response — {{dispute.external_ref}}',
  'Transmits the record and information requested by the certified IDR entity, with an exhibit list.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'items_provided','Items enclosed / responses','What you are providing.','textarea',null,'""'::jsonb,false,true,
     'Write one concise professional paragraph introducing the enclosed materials responsive to a certified IDR entity''s information request, grounded only in supplied facts. Do not invent facts.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='idre_info_response' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Response to information request — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits the following in response to your request for additional information in the above dispute.</p>',null,null),
  (40,'items','<p>{{answers.items_provided}}</p>','{"answer":"items_provided"}'::jsonb,null),
  (88,'exhibits','<p>The following materials are enclosed and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 5. Improper-batching objection ════════════════════════════════════════
delete from public.document_templates where code='batching_objection' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'batching_objection','batching_objection','Batching objection — {{dispute.external_ref}}',
  'Objects that a batched dispute is improperly constituted under the §149.510(c)(3) batching conditions.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'defect','Which batching condition fails',null,'select',
     '[{"value":"provider","label":"Not the same provider/facility"},{"value":"plan","label":"Not the same plan/issuer"},{"value":"code","label":"Not the same or similar service code"},{"value":"window","label":"Outside the batching time window"}]'::jsonb,
     '"code"'::jsonb,false,false,null),
  (40,'detail','Detail','Explain the defect.','textarea',null,'""'::jsonb,false,true,
     'Write one concise professional paragraph explaining why a provider''s batched No Surprises Act IDR dispute fails the batching conditions, grounded only in supplied facts. Do not invent facts.'),
  (50,'request_separation','Request dismissal/separation',null,'boolean',null,'true'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='batching_objection' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Objection to improper batching — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity and {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) objects that the above batched dispute is improperly constituted under 45 CFR §149.510(c)(3), which permits batching only where the items share the same provider or facility, the same plan or issuer, the same or similar service code, and fall within the same batching period.</p>',null,null),
  (40,'defect_provider','<p>The batched items are not furnished by the same provider or the same facility (same NPI/TIN), so batching is not permitted.</p>','{"answer":"defect","equals":"provider"}'::jsonb,null),
  (42,'defect_plan','<p>The batched items do not involve the same plan or issuer, so batching is not permitted.</p>','{"answer":"defect","equals":"plan"}'::jsonb,null),
  (44,'defect_code','<p>The batched items are not the same or a similar service code, so batching is not permitted.</p>','{"answer":"defect","equals":"code"}'::jsonb,null),
  (46,'defect_window','<p>The batched items fall outside the permitted batching time window, so batching is not permitted.</p>','{"answer":"defect","equals":"window"}'::jsonb,null),
  (50,'detail','<p>{{answers.detail}}</p>','{"answer":"detail"}'::jsonb,null),
  (60,'request','<p>The Plan requests that the batched dispute be dismissed, or that the non-conforming items be separated and dismissed, as improperly batched.</p>','{"answer":"request_separation","equals":true}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 6. QPA disclosure / methodology letter ════════════════════════════════
delete from public.document_templates where code='qpa_disclosure' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'qpa_disclosure','qpa_disclosure','QPA disclosure — {{dispute.external_ref}}',
  'Provides the QPA information required on request, with the benchmark table and optional downcoding disclosure.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'include_benchmarks','Include benchmark table',null,'boolean',null,'true'::jsonb,false,false,null),
  (40,'downcoding','Include downcoding disclosure','Add the additional disclosures required when a service code was downcoded.','boolean',null,'false'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='qpa_disclosure' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Qualifying Payment Amount disclosure — {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>To {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) provides the following Qualifying Payment Amount (QPA) information in response to your request, consistent with the disclosure requirements at 45 CFR §149.140.</p>',null,null),
  (40,'qpa_para','<p>The QPA for this item is {{money.qpa}}, determined using the {{qpa.methodology}}. The QPA is calculated as the median of the Plan''s contracted rates for the same or similar item in the geographic region, indexed as required.</p>',null,null),
  (50,'benchmarks','<p>Reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}'::jsonb,null),
  (60,'downcoding','<p>Where the service code billed was modified for purposes of calculating the QPA, the Plan additionally discloses that the QPA is based on the modified code, a statement that the code was modified, and the rationale for the modification, as required.</p>','{"answer":"downcoding","equals":true}'::jsonb,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 7. Award payment / remittance notice ══════════════════════════════════
delete from public.document_templates where code='award_remittance' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'award_remittance','award_remittance','Award remittance — {{dispute.external_ref}}',
  'Transmits payment of the certified IDR entity''s determination within the required window (the compliance rail).','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'award_amount','Determined amount',null,'text',null,'""'::jsonb,true,false,null),
  (40,'payment_ref','Payment reference','Check or EFT reference.','text',null,'""'::jsonb,false,false,null),
  (50,'payment_date','Payment date',null,'text',null,'""'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='award_remittance' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Payment of IDR determination — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) transmits payment of the amount selected by the certified IDR entity for the above item, within the payment window required by the No Surprises Act.</p>',null,null),
  (40,'amount','<p>Amount paid: {{answers.award_amount}}. Reference: {{answers.payment_ref}}. Payment date: {{answers.payment_date}}.</p>',null,null),
  (50,'close','<p>This payment fully satisfies the Plan''s obligation under the determination for this item.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 8. Response to a CMS / NSA complaint ══════════════════════════════════
delete from public.document_templates where code='cms_complaint_response' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'cms_complaint_response','cms_complaint_response','Complaint response — {{dispute.external_ref}}',
  'The plan''s response to a No Surprises Act complaint (e.g., a provider''s non-payment or process complaint).','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'complaint_ref','Complaint reference',null,'text',null,'""'::jsonb,false,false,null),
  (40,'response_basis','Response','The plan''s substantive response.','textarea',null,'""'::jsonb,false,true,
     'Write one concise professional paragraph responding to a No Surprises Act complaint on behalf of a health plan, grounded only in supplied facts and record. Measured, cooperative tone. Do not invent facts.')
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='cms_complaint_response' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Response to complaint {{answers.complaint_ref}} — Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the No Surprises Help Desk and the Departments:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this response to the referenced complaint concerning the above item and is committed to full compliance with the No Surprises Act.</p>',null,null),
  (40,'basis','<p>{{answers.response_basis}}</p>','{"answer":"response_basis"}'::jsonb,null),
  (88,'exhibits','<p>The following materials document the Plan''s handling of this matter:</p>{{exhibits}}','{"flag":"has_evidence"}'::jsonb,null),
  (50,'close','<p>The Plan is available to provide any additional information the Departments require.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 9. Cost-share correction notice ═══════════════════════════════════════
delete from public.document_templates where code='cost_share_correction' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'cost_share_correction','cost_share_correction','Cost-share correction — {{dispute.external_ref}}',
  'Corrects patient cost-sharing to the recognized amount (the QPA absent a specified State/All-Payer amount).','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'corrected_costshare','Corrected cost-share',null,'text',null,'""'::jsonb,true,false,null),
  (40,'member_ref','Member reference (optional)',null,'text',null,'""'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='cost_share_correction' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Cost-share correction — {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}{{answers.member_ref}}</p>',null::jsonb,null::text),
  (20,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) is correcting the patient cost-sharing for the above item so that it is calculated on the recognized amount, as required by 45 CFR §149.110(c) and §149.120(c)(2).</p>',null,null),
  (30,'correction','<p>The corrected patient cost-share is {{answers.corrected_costshare}}, based on the recognized amount (the Plan''s Qualifying Payment Amount of {{money.qpa}} absent a specified State law or All-Payer Model amount). Any amount previously applied in excess of this figure is adjusted accordingly.</p>',null,null),
  (40,'close','<p>The patient''s liability for this item is limited to the corrected in-network cost-share; the patient is protected from balance billing under the No Surprises Act.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 10. Member balance-billing protection notice ══════════════════════════
delete from public.document_templates where code='member_protection_notice' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'member_protection_notice','member_protection_notice','Member protection notice — {{dispute.external_ref}}',
  'Plain-language letter to the member confirming No Surprises Act balance-billing protection and their capped cost-share.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Plan Member Services"'::jsonb,false,false,null),
  (30,'member_name','Member name',null,'text',null,'""'::jsonb,true,false,null),
  (40,'member_costshare','Member cost-share',null,'text',null,'""'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='member_protection_notice' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p>',null::jsonb,null::text),
  (20,'salutation','<p>Dear {{answers.member_name}},</p>',null,null),
  (30,'intro','<p>You received care on {{date.service}} from a provider who was out of your plan''s network. Under the federal No Surprises Act, you are protected from surprise balance billing for this care.</p>',null,null),
  (40,'protection','<p>Your responsibility for this item is limited to your normal in-network cost-share of {{answers.member_costshare}}. You should not be billed any amount above that. Your plan is handling the rest directly with the provider.</p>',null,null),
  (50,'whatnext','<p>If you receive a bill from the provider for more than your in-network cost-share, please do not pay it — contact {{org.name}} member services and we will help resolve it.</p>',null,null),
  (90,'signature','<p class="sig">Sincerely,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);

-- ═══ 11. State-process redirection letter ══════════════════════════════════
delete from public.document_templates where code='state_redirection' and org_id is null;
with t as (insert into public.document_templates (org_id,code,kind,title,description,jurisdiction)
  values (null,'state_redirection','state_redirection','State-process redirection — {{dispute.external_ref}}',
  'Redirects a dispute to a qualifying State process where a specified State law or All-Payer Model governs.','federal') returning id)
insert into public.template_questions (template_id,seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt)
select t.id,v.* from t,(values
  (10,'signer_name','Signer name',null,'text',null::jsonb,null::jsonb,true,false,null::text),
  (20,'signer_title','Signer title',null,'text',null,'"Authorized Plan Representative"'::jsonb,false,false,null),
  (30,'state_name','State',null,'text',null,'""'::jsonb,true,false,null),
  (40,'state_process','State process name',null,'text',null,'""'::jsonb,false,false,null)
) as v(seq,key,prompt,help,input_type,options,default_val,required,ai_assist,ai_prompt);
with t as (select id from public.document_templates where code='state_redirection' and org_id is null)
insert into public.template_clauses (template_id,seq,key,body,include_when,repeat_over)
select t.id,v.* from t,(values
  (10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Federal IDR jurisdiction objection — Federal IDR Dispute {{dispute.external_ref}}</strong></p>',null::jsonb,null::text),
  (20,'salutation','<p>To the Certified IDR Entity and {{initiator.name}}:</p>',null,null),
  (30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) objects to Federal IDR jurisdiction over the above item. This item is governed by {{answers.state_name}}''s specified State law or All-Payer Model Agreement, which supplies the method for determining the out-of-network amount, so the item is not a qualified item for the Federal IDR process under 45 CFR §149.510(a)(2) and the definitions at §149.30.</p>',null,null),
  (40,'process','<p>The appropriate forum for this item is {{answers.state_process}}.</p>','{"answer":"state_process"}'::jsonb,null),
  (50,'request','<p>The Plan requests that the certified IDR entity determine this dispute ineligible for the Federal IDR process and close it so the matter may proceed under the applicable State process.</p>',null,null),
  (90,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',null,null)
) as v(seq,key,body,include_when,repeat_over);
