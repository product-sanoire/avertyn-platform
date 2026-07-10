-- Vertical 1: State surprise-billing arbitration rulebook (NY + TX)
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
-- Additive only: new legal_authorities, new eligibility_rules (catalog; not auto-scored),
-- new jurisdiction-tagged document_templates. Does not alter federal screening.

ALTER TABLE public.eligibility_rules ADD COLUMN IF NOT EXISTS jurisdiction text NOT NULL DEFAULT 'federal';

-- Legal authorities (state law) — marked unverified pending counsel review
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,effective_note,source_url)
SELECT v.code,v.citation,nullif(v.mirrors,''),v.topic,'unverified',true,0.6,
       'State-law citation — confirm exact subsection and current filing deadlines with counsel before a live filing.',v.src
FROM (VALUES
  ('NY_SURPRISE_IDR','N.Y. Financial Services Law Art. 6 (§§601-609); N.Y. Insurance Law §3241','','NY surprise-bill & emergency-services IDR','https://www.dfs.ny.gov/IDR'),
  ('NY_IDR_STD','N.Y. Financial Services Law §605; 23 NYCRR 400.19','','NY IDR reviewer standard (80th percentile UCR / FAIR Health)','https://www.dfs.ny.gov/IDR'),
  ('TX_IDR_CH1467','Tex. Ins. Code Ch. 1467 (SB 1264, 86th Leg.)','','TX out-of-network mediation & arbitration','https://www.tdi.texas.gov/medical-billing/index.html'),
  ('TX_ARB_FACTORS','Tex. Ins. Code §§1467.083-.084','','TX arbitration standard & statutory factors','https://www.tdi.texas.gov/medical-billing/idr-process-faq.html'),
  ('TX_MEDIATION','Tex. Ins. Code §§1467.051-.057','','TX facility mediation','https://www.tdi.texas.gov/medical-billing/idr-process-faq.html')
) v(code,citation,mirrors,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

-- Eligibility rules (state catalog; hardcoded scorers do not iterate this table, so additive-safe)
INSERT INTO public.eligibility_rules(code,name,description,category,severity,authority,argument,authority_code,jurisdiction)
SELECT v.code,v.name,v.descr,v.cat,v.sev,v.auth,v.arg,v.acode,v.jur
FROM (VALUES
  ('NY_JUR_APPLIES','NY surprise-bill jurisdiction','Claim governed by NY specified State law, not Federal IDR','jurisdiction','disqualifying',
   'N.Y. Financial Services Law Art. 6; 45 CFR §149.30',
   'This claim is governed by New York&rsquo;s surprise-bill and emergency-services IDR, a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply and the dispute proceeds under N.Y. Financial Services Law Art. 6.',
   'NY_SURPRISE_IDR','NY'),
  ('NY_TF','NY IDR filing window','NY IDR request must be filed within the state deadline','timely_filing','disqualifying',
   'N.Y. Financial Services Law §605',
   'The New York IDR request must be filed within the deadline set by the applicable New York process; confirm the current window before filing.',
   'NY_SURPRISE_IDR','NY'),
  ('NY_STD_UCR','NY 80th-percentile UCR standard','NY reviewer weighs 80th percentile of usual & customary (FAIR Health)','qualified_item','warning',
   'N.Y. Financial Services Law §605; 23 NYCRR 400.19',
   'The New York reviewer weighs statutory factors including the 80th percentile of usual and customary charges from an independent benchmarking database; the Plan&rsquo;s payment at or near that benchmark is the reasonable fee.',
   'NY_IDR_STD','NY'),
  ('TX_JUR_APPLIES','TX SB 1264 jurisdiction','Fully-insured TX OON claim governed by SB 1264, not Federal IDR','jurisdiction','disqualifying',
   'Tex. Ins. Code Ch. 1467; 45 CFR §149.30',
   'This fully-insured Texas out-of-network claim is governed by SB 1264 (Tex. Ins. Code Ch. 1467), a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'TX_IDR_CH1467','TX'),
  ('TX_ERISA_EXCL','TX excludes self-funded ERISA','Self-funded ERISA / federal-NSA claims are outside SB 1264','qualified_item','disqualifying',
   'Tex. Ins. Code Ch. 1467',
   'Self-funded ERISA plans and claims subject to the Federal No Surprises Act are outside the Texas SB 1264 process and are not eligible for Texas mediation or arbitration.',
   'TX_IDR_CH1467','TX'),
  ('TX_TF','TX IDR request window','TX arbitration/mediation request due within the statutory window','timely_filing','disqualifying',
   'Tex. Ins. Code §1467.084',
   'The Texas arbitration or mediation request must be submitted within the statutory window after payment; confirm the current deadline before filing.',
   'TX_ARB_FACTORS','TX'),
  ('TX_MED_ARB','TX mediation vs arbitration routing','Facilities route to mediation; non-facility providers to arbitration','jurisdiction','warning',
   'Tex. Ins. Code §§1467.051, 1467.083',
   'Out-of-network facilities and the health plan use mediation; out-of-network non-facility providers and the health plan use arbitration. Confirm the correct track for this claim.',
   'TX_MEDIATION','TX'),
  ('TX_10FACTOR','TX arbitration statutory factors','Arbitrator weighs the SB 1264 factors incl. 80th/50th percentile FAIR Health','qualified_item','warning',
   'Tex. Ins. Code §1467.084',
   'The arbitrator selects the offer closest to the reasonable amount, weighing the statutory factors including the 80th and 50th percentiles of applicable benchmark charges, provider training and experience, service complexity, regional fee disparities, and contracting history.',
   'TX_ARB_FACTORS','TX')
) v(code,name,descr,cat,sev,auth,arg,acode,jur)
WHERE NOT EXISTS (SELECT 1 FROM public.eligibility_rules er WHERE er.code=v.code);

-- Document templates (state jurisdiction) + clauses + questions
DO $$
DECLARE tid uuid;
BEGIN
  -- NY IDR position
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='ny_idr_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'ny_idr_position','ny_idr_position','NY IDR position — {{dispute.external_ref}}',
      'Plan submission to a New York IDR reviewer defending the plan payment as the reasonable fee under NY FSL Art. 6.','NY')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan submission &mdash; New York IDR, surprise bill {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the New York Independent Dispute Resolution Entity:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this determination request under New York&rsquo;s surprise-bill and emergency-services dispute process ({{cite.NY_SURPRISE_IDR}}) and requests that the reviewer select the Plan&rsquo;s payment as the reasonable fee for the service in dispute.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.NY_IDR_STD}}, the reviewer selects either the health plan&rsquo;s payment or the provider&rsquo;s fee as reasonable, weighing statutory factors including the 80th percentile of usual and customary charges reported by an independent benchmarking database and the circumstances of the service.</p>',NULL,NULL),
      (tid,50,'payment','<p>The Plan&rsquo;s payment of {{money.qpa}} is consistent with the applicable New York standard and the recognized market rate for this service. The provider&rsquo;s demand of {{money.demand}} reflects billed charges rather than a reasonable fee.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s payment is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>For these reasons, the Plan respectfully requests that the reviewer select the Plan&rsquo;s payment of {{money.qpa}} as the reasonable fee.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  -- TX arbitration position
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='tx_arbitration_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'tx_arbitration_position','tx_arbitration_position','TX arbitration position — {{dispute.external_ref}}',
      'Plan submission to a Texas SB 1264 arbitrator arguing the plan offer is closest to the reasonable amount under Tex. Ins. Code Ch. 1467.','TX')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan submission &mdash; Texas arbitration (SB 1264) {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Arbitrator:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this statement under the Texas out-of-network arbitration process ({{cite.TX_IDR_CH1467}}) and requests that the arbitrator find the Plan&rsquo;s offer closest to the reasonable amount for the service in dispute.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.TX_ARB_FACTORS}}, the arbitrator selects the offer closest to the reasonable amount, weighing the statutory factors, including the 80th and 50th percentiles of applicable benchmark charges, the provider&rsquo;s training and experience, the complexity of the service, regional fee disparities, and prior contracting history.</p>',NULL,NULL),
      (tid,50,'offer','<p>The Plan&rsquo;s offer of {{money.qpa}} reflects the recognized market rate for this service; the provider&rsquo;s demand of {{money.demand}} reflects billed charges and exceeds the reasonable amount.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s offer is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'f_market','<p>The benchmark median is the best evidence of the reasonable amount for this service in the market; the additional factors do not justify the provider&rsquo;s billed charges.</p>','{"answer":"emphasis","equals":"qpa"}',NULL),
      (tid,72,'f_quality','<p>The acuity and complexity of the service are already reflected in the benchmark and the service coding; nothing in the record supports a fee above the reasonable amount on quality grounds.</p>','{"answer":"emphasis","equals":"quality"}',NULL),
      (tid,74,'f_goodfaith','<p>The Plan has made good-faith efforts to contract for this service at market rates; the provider&rsquo;s decision to remain out-of-network does not support a fee above the reasonable amount.</p>','{"answer":"emphasis","equals":"goodfaith"}',NULL),
      (tid,80,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>For these reasons, the Plan respectfully requests that the arbitrator find the Plan&rsquo;s offer of {{money.qpa}} closest to the reasonable amount.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'emphasis','Primary factor to emphasize','select','[{"label":"Benchmark / market rate","value":"qpa"},{"label":"Quality / complexity","value":"quality"},{"label":"Good-faith network efforts","value":"goodfaith"}]'::jsonb,'"qpa"'::jsonb,false,false),
      (tid,40,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,50,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  -- TX facility mediation position
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='tx_mediation_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'tx_mediation_position','tx_mediation_position','TX mediation position — {{dispute.external_ref}}',
      'Plan submission for a Texas SB 1264 facility mediation under Tex. Ins. Code §§1467.051-.057.','TX')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan submission &mdash; Texas mediation (SB 1264) {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Mediator:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this statement for the Texas out-of-network facility mediation process ({{cite.TX_MEDIATION}}) and seeks resolution at or near the recognized market rate for the service in dispute.</p>',NULL,NULL),
      (tid,40,'position','<p>The Plan&rsquo;s payment of {{money.qpa}} reflects the recognized market rate for this service; the facility&rsquo;s demand of {{money.demand}} reflects billed charges. The Plan is prepared to resolve this matter informally at or near that amount.</p>',NULL,NULL),
      (tid,50,'benchmarks','<p>The Plan&rsquo;s payment is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,90,'request','<p>The Plan respectfully requests resolution at or near {{money.qpa}}.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;
END $$;
