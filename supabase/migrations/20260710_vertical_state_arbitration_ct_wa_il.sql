-- Vertical 1c: State surprise-billing rulebook — Connecticut + Washington + Illinois
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
-- Additive only; state citations status='unverified' pending counsel review.
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,effective_note,source_url)
SELECT v.code,v.citation,nullif(v.mirrors,''),v.topic,'unverified',true,0.6,v.note,v.src
FROM (VALUES
  ('CT_SURPRISE','Conn. Gen. Stat. §38a-477aa (PA 15-146)','','CT surprise-bill / OON reimbursement','State-law citation — confirm subsection with counsel before a live filing.','https://law.justia.com/codes/connecticut/title-38a/chapter-700c/section-38a-477aa/'),
  ('CT_STD','Conn. Gen. Stat. §38a-477aa(b)','','CT OON payment standard (greatest of in-network / 80th percentile UCR / Medicare)','State-law citation — confirm subsection with counsel before a live filing.','https://codes.findlaw.com/ct/title-38a-insurance/ct-gen-st-sect-38a-477aa.html'),
  ('WA_BBPA','RCW 48.49 (Balance Billing Protection Act)','','WA Balance Billing Protection Act','State-law citation — confirm subsection with counsel before a live filing.','https://app.leg.wa.gov/RCW/default.aspx?cite=48.49&full=true'),
  ('WA_ARB','RCW 48.49 arbitration (OIC); commercially reasonable amount','','WA balance-billing final-offer arbitration','State-law citation — confirm subsection with counsel before a live filing.','https://www.insurance.wa.gov/laws-rules/administrative-hearings/balance-billing-protection-act-arbitration'),
  ('IL_SURPRISE','215 ILCS 5/356z.3a (PA 102-0901)','','IL balance-billing / OON (substantially aligns with federal NSA)','IL substantially aligns with / defers to the federal NSA for many OON services — verify whether the IL state process or Federal IDR governs before filing.','https://ilga.gov/legislation/ilcs/fulltext.asp?DocName=021500050K356z.3a')
) v(code,citation,mirrors,topic,note,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.eligibility_rules(code,name,description,category,severity,authority,argument,authority_code,jurisdiction)
SELECT v.code,v.name,v.descr,v.cat,v.sev,v.auth,v.arg,v.acode,v.jur
FROM (VALUES
  ('CT_JUR_APPLIES','CT §38a-477aa jurisdiction','Fully-insured CT claim governed by the CT reimbursement standard','jurisdiction','disqualifying',
   'Conn. Gen. Stat. §38a-477aa; 45 CFR §149.30',
   'This fully-insured Connecticut out-of-network claim is governed by Conn. Gen. Stat. §38a-477aa, a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'CT_SURPRISE','CT'),
  ('CT_STD_GREATEST','CT greatest-of payment standard','Reimbursement = greatest of in-network / 80th pct UCR / Medicare','qualified_item','warning',
   'Conn. Gen. Stat. §38a-477aa(b)',
   'Under Conn. Gen. Stat. §38a-477aa the reimbursement for this out-of-network service is the greatest of the in-network rate, the 80th percentile of usual and customary charges from an independent database, or the Medicare rate; the Plan&rsquo;s payment at or above that amount is compliant.',
   'CT_STD','CT'),
  ('WA_JUR_APPLIES','WA BBPA jurisdiction','WA-regulated/opt-in claim governed by the BBPA, not Federal IDR','jurisdiction','disqualifying',
   'RCW 48.49; 45 CFR §149.30',
   'This claim is governed by Washington&rsquo;s Balance Billing Protection Act (RCW 48.49), a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'WA_BBPA','WA'),
  ('WA_ARB_COMMRE','WA commercially-reasonable arbitration','Baseball arbitration on a commercially reasonable amount','qualified_item','warning',
   'RCW 48.49 arbitration',
   'Washington arbitration is final-offer (baseball) style on a commercially reasonable amount, weighing statutory factors including the median in-network rate from the balance-billing data set, provider training and experience, and the circumstances of the service; the Plan&rsquo;s offer at the market rate should be selected.',
   'WA_ARB','WA'),
  ('WA_EXHAUST','WA negotiation before arbitration','30-day open negotiation must precede WA arbitration','open_negotiation','warning',
   'RCW 48.49 arbitration',
   'The Washington process requires a good-faith negotiation period before arbitration; confirm completion before filing.',
   'WA_ARB','WA'),
  ('IL_JUR_APPLIES','IL 356z.3a jurisdiction','IL OON balance-billing claim — verify IL vs federal governance','jurisdiction','warning',
   '215 ILCS 5/356z.3a; 45 CFR §149.30',
   'This Illinois out-of-network claim is addressed by 215 ILCS 5/356z.3a. Illinois substantially aligns with and defers to the Federal No Surprises Act for many out-of-network services; confirm whether the Illinois state process or the Federal IDR process governs this claim.',
   'IL_SURPRISE','IL'),
  ('IL_NSA_ALIGN','IL alignment with federal NSA','IL defers to federal NSA for many OON services','qualified_item','warning',
   '215 ILCS 5/356z.3a (PA 102-0901)',
   'Illinois Public Act 102-0901 aligns Illinois with the Federal No Surprises Act; for services subject to the federal Act the Federal IDR framework and QPA defense apply, and the Plan&rsquo;s payment at the recognized market rate is supported.',
   'IL_SURPRISE','IL')
) v(code,name,descr,cat,sev,auth,arg,acode,jur)
WHERE NOT EXISTS (SELECT 1 FROM public.eligibility_rules er WHERE er.code=v.code);

DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='ct_payment_standard_defense';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'ct_payment_standard_defense','ct_payment_standard_defense','CT payment-standard defense — {{dispute.external_ref}}',
      'Plan statement that its reimbursement satisfies the Connecticut §38a-477aa greatest-of standard.','CT')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan payment determination &mdash; Connecticut out-of-network {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Reviewing Authority:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) states that its reimbursement for the service in dispute complies with Connecticut&rsquo;s out-of-network reimbursement statute ({{cite.CT_SURPRISE}}).</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.CT_STD}}, the reimbursement for this out-of-network service is the greatest of the in-network rate, the 80th percentile of usual and customary charges from an independent database, or the Medicare rate.</p>',NULL,NULL),
      (tid,50,'payment','<p>The Plan paid {{money.qpa}}, at or above the applicable Connecticut standard; the provider&rsquo;s demand of {{money.demand}} reflects billed charges and exceeds the statutory amount.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s payment is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>The Plan&rsquo;s reimbursement of {{money.qpa}} satisfies the Connecticut standard and no additional payment is due.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='wa_arbitration_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'wa_arbitration_position','wa_arbitration_position','WA arbitration position — {{dispute.external_ref}}',
      'Plan final-offer submission to a Washington BBPA arbitrator under RCW 48.49.','WA')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan final offer &mdash; Washington balance-billing arbitration {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Arbitrator:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this final offer under Washington&rsquo;s Balance Billing Protection Act ({{cite.WA_BBPA}}) and requests that the arbitrator select the Plan&rsquo;s final offer as the commercially reasonable amount.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.WA_ARB}}, this is a final-offer (baseball) arbitration on a commercially reasonable amount, weighing statutory factors including the median in-network rate from the balance-billing data set, provider training and experience, and the circumstances of the service.</p>',NULL,NULL),
      (tid,50,'offer','<p>The Plan&rsquo;s final offer of {{money.qpa}} reflects the commercially reasonable, market rate for this service; the provider&rsquo;s demand of {{money.demand}} reflects billed charges and exceeds that amount.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s final offer is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>For these reasons, the Plan respectfully requests that the arbitrator select the Plan&rsquo;s final offer of {{money.qpa}}.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='il_balance_bill_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'il_balance_bill_position','il_balance_bill_position','IL balance-billing position — {{dispute.external_ref}}',
      'Plan submission under 215 ILCS 5/356z.3a; note IL substantially aligns with the federal NSA.','IL')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan position &mdash; Illinois out-of-network balance billing {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Reviewing Authority:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this position under Illinois&rsquo; out-of-network balance-billing statute ({{cite.IL_SURPRISE}}). Illinois substantially aligns with the Federal No Surprises Act for out-of-network services.</p>',NULL,NULL),
      (tid,40,'standard','<p>Whether resolved under the Illinois statute or the aligned Federal framework, the recognized market rate for this service governs; the Plan&rsquo;s payment reflects that rate.</p>',NULL,NULL),
      (tid,50,'payment','<p>The Plan paid {{money.qpa}}, consistent with the recognized market rate; the provider&rsquo;s demand of {{money.demand}} reflects billed charges rather than the reasonable amount.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s payment is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>For these reasons, the Plan respectfully requests that the Plan&rsquo;s payment of {{money.qpa}} be upheld.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;
END $$;
