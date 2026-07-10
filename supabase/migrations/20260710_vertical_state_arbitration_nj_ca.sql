-- Vertical 1b: State surprise-billing rulebook — New Jersey + California
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
-- Additive only; state citations status='unverified' pending counsel review.
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,effective_note,source_url)
SELECT v.code,v.citation,nullif(v.mirrors,''),v.topic,'unverified',true,0.6,
       'State-law citation — confirm exact subsection and current deadlines/thresholds with counsel before a live filing.',v.src
FROM (VALUES
  ('NJ_OON_ACT','N.J.S.A. 26:2SS-1 et seq. (P.L. 2018, c.32)','','NJ Out-of-network Consumer Protection & arbitration','https://www.nj.gov/dobi/division_insurance/oonarbitration/'),
  ('NJ_ARB','N.J.A.C. 11:24C; NJ DOBI OON arbitration (baseball / final-offer)','','NJ out-of-network arbitration process','https://www.nj.gov/dobi/division_insurance/oonarbitration/requestform.pdf'),
  ('CA_IDRP_HSC','Cal. Health & Safety Code §1371.30 (AB 72)','Cal. Ins. Code §10112.8','CA DMHC Independent Dispute Resolution Process (non-emergency OON)','https://www.dmhc.ca.gov/fileacomplaint/providercomplaintagainstaplan/nonemergencyservicesindependentdisputeresolutionprocess.aspx'),
  ('CA_AVG_RATE','Cal. Health & Safety Code §1371.31 (AB 72 interim payment)','','CA interim payment: greater of average contracted rate or 125% of Medicare','https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=201520160AB72')
) v(code,citation,mirrors,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.eligibility_rules(code,name,description,category,severity,authority,argument,authority_code,jurisdiction)
SELECT v.code,v.name,v.descr,v.cat,v.sev,v.auth,v.arg,v.acode,v.jur
FROM (VALUES
  ('NJ_JUR_APPLIES','NJ OON Act jurisdiction','Fully-insured/opt-in NJ claim governed by the OON Act, not Federal IDR','jurisdiction','disqualifying',
   'N.J.S.A. 26:2SS; 45 CFR §149.30',
   'This claim is governed by New Jersey&rsquo;s Out-of-network Consumer Protection Act, a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'NJ_OON_ACT','NJ'),
  ('NJ_APPEAL_FIRST','NJ internal appeal before arbitration','Internal appeal / negotiation must precede NJ arbitration','open_negotiation','warning',
   'N.J.A.C. 11:24C',
   'The New Jersey process requires the internal appeal and negotiation steps to be exhausted before arbitration; confirm completion before filing.',
   'NJ_ARB','NJ'),
  ('NJ_ARB_BASEBALL','NJ final-offer (baseball) arbitration','Arbitrator selects one party&rsquo;s final offer','qualified_item','warning',
   'N.J.A.C. 11:24C',
   'New Jersey arbitration is final-offer (baseball) style: the arbitrator selects either the Plan&rsquo;s or the provider&rsquo;s final offer as the reasonable amount; the Plan&rsquo;s offer at the market rate should be selected.',
   'NJ_ARB','NJ'),
  ('CA_JUR_APPLIES','CA AB 72 jurisdiction','DMHC/CDI-regulated CA claim governed by AB 72, not Federal IDR','jurisdiction','disqualifying',
   'Cal. Health & Safety Code §1371.30; 45 CFR §149.30',
   'This claim under a California DMHC- or CDI-regulated plan is governed by AB 72, a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'CA_IDRP_HSC','CA'),
  ('CA_INTERIM_PAY','CA AB 72 interim payment standard','Interim payment = greater of average contracted rate or 125% Medicare','qualified_item','warning',
   'Cal. Health & Safety Code §1371.31',
   'Under AB 72 the interim payment is the greater of the Plan&rsquo;s average contracted rate or 125% of the Medicare rate; the Plan&rsquo;s payment at that standard is compliant and should be upheld.',
   'CA_AVG_RATE','CA'),
  ('CA_EXHAUST','CA exhaust plan dispute resolution','Provider must use the plan&rsquo;s dispute resolution before IDRP','open_negotiation','warning',
   'Cal. Health & Safety Code §1371.30',
   'The provider must exhaust the Plan&rsquo;s contracted-provider dispute resolution mechanism before invoking the California IDRP; confirm this before the matter proceeds.',
   'CA_IDRP_HSC','CA')
) v(code,name,descr,cat,sev,auth,arg,acode,jur)
WHERE NOT EXISTS (SELECT 1 FROM public.eligibility_rules er WHERE er.code=v.code);

DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='nj_arbitration_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'nj_arbitration_position','nj_arbitration_position','NJ arbitration position — {{dispute.external_ref}}',
      'Plan final-offer submission to a New Jersey OON arbitrator under N.J.S.A. 26:2SS.','NJ')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan final offer &mdash; New Jersey OON arbitration {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Arbitrator:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this final offer under the New Jersey Out-of-network Consumer Protection Act ({{cite.NJ_OON_ACT}}) and requests that the arbitrator select the Plan&rsquo;s final offer as the reasonable amount for the service in dispute.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.NJ_ARB}}, this is a final-offer (baseball) arbitration: the arbitrator selects either the Plan&rsquo;s or the provider&rsquo;s final offer, weighing the statutory factors. No departure above the market rate is warranted.</p>',NULL,NULL),
      (tid,50,'offer','<p>The Plan&rsquo;s final offer of {{money.qpa}} reflects the recognized market rate for this service; the provider&rsquo;s demand of {{money.demand}} reflects billed charges and exceeds the reasonable amount.</p>',NULL,NULL),
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

  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='ca_idrp_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'ca_idrp_position','ca_idrp_position','CA IDRP position — {{dispute.external_ref}}',
      'Plan submission to the California IDRP defending payment at the AB 72 interim standard (Health & Safety Code §1371.30-.31).','CA')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan submission &mdash; California IDRP (AB 72) {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Independent Dispute Resolution Organization:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this statement under the California Independent Dispute Resolution Process ({{cite.CA_IDRP_HSC}}) for non-emergency out-of-network services and requests that the Plan&rsquo;s payment be upheld.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.CA_AVG_RATE}}, the interim payment for these services is the greater of the Plan&rsquo;s average contracted rate or 125% of the applicable Medicare rate; the Plan&rsquo;s payment satisfies that standard.</p>',NULL,NULL),
      (tid,50,'payment','<p>The Plan paid {{money.qpa}}, consistent with the AB 72 interim payment standard and the recognized market rate. The provider&rsquo;s demand of {{money.demand}} reflects billed charges rather than the reasonable amount.</p>',NULL,NULL),
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
