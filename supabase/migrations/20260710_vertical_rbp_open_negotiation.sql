-- Bucket 2 (data-only slice): reference-based pricing substantiation + OON repricing/pre-IDR negotiation
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,last_verified_at,verified_by,effective_note,source_url)
SELECT v.code,v.citation,NULL,v.topic,v.status,true,v.conf,
       CASE WHEN v.status='verified' THEN now() ELSE NULL END,
       CASE WHEN v.status='verified' THEN 'claude-web 2026-07-10' ELSE NULL END,
       v.note,v.src
FROM (VALUES
  ('MEDICARE_REF','Medicare physician fee schedule (42 CFR part 414)','Medicare benchmark basis for reference-based pricing','verified',0.9,'','https://www.ecfr.gov/current/title-42/part-414'),
  ('RBP_PLAN_TERMS','Plan document / SPD reference-based-pricing provision (ERISA plan terms)','Reference-based pricing plan design','unverified',0.5,'Cite the specific plan/SPD RBP provision and applicable multiple; confirm plan terms before use.','')
) v(code,citation,topic,status,conf,note,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='rbp_substantiation';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'rbp_substantiation','rbp_substantiation','Reference-based-pricing substantiation — {{dispute.external_ref}}',
      'Substantiates a plan reference-based price (e.g., a multiple of Medicare) for an out-of-network claim.','federal')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'caption','<p class="doc-meta">{{date.today}}</p><p style="text-align:center"><strong>REFERENCE-BASED PRICING &mdash; PAYMENT SUBSTANTIATION</strong></p>',NULL,NULL),
      (tid,15,'parties','<p><strong>{{dispute.plan_legal_name}}</strong> &middot; {{dispute.reference}} &middot; CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}</p>',NULL,NULL),
      (tid,20,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) substantiates its allowed amount of {{money.qpa}} for the out-of-network item in dispute under the Plan&rsquo;s reference-based-pricing provision ({{cite.RBP_PLAN_TERMS}}).</p>',NULL,NULL),
      (tid,30,'basis','<p>The allowed amount was determined as a defined multiple of the Medicare allowable for this service ({{cite.MEDICARE_REF}}), consistent with {{qpa.methodology}}. The provider&rsquo;s demand of {{money.demand}} reflects billed charges rather than the plan&rsquo;s reference-based allowed amount.</p>',NULL,NULL),
      (tid,40,'benchmarks','<p>The allowed amount is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,50,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,90,'conclusion','<p>The Plan&rsquo;s allowed amount of {{money.qpa}} is properly determined under the reference-based-pricing methodology and is the amount payable for this service.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional detail (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='oon_repricing_notice';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'oon_repricing_notice','oon_repricing_notice','OON repricing & pre-IDR offer — {{dispute.external_ref}}',
      'Notifies the provider that an out-of-network claim was repriced to the plan allowed amount and invites resolution before IDR.','federal')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Out-of-network claim repricing &amp; resolution offer {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To {{initiator.name}}:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) has repriced the above out-of-network claim to the Plan&rsquo;s allowed amount of {{money.qpa}}, determined using {{qpa.methodology}}.</p>',NULL,NULL),
      (tid,40,'offer','<p>To resolve this matter promptly and avoid the dispute-resolution process, the Plan offers to settle at {{money.qpa}}. The billed charge of {{money.demand}} exceeds the recognized market rate for this service.</p>',NULL,NULL),
      (tid,50,'benchmarks','<p>The Plan&rsquo;s allowed amount is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,60,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,90,'request','<p>Please contact the Plan within the applicable open-negotiation period to accept this offer or discuss resolution.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,40,'extra_argument','Additional detail (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;
END $$;
