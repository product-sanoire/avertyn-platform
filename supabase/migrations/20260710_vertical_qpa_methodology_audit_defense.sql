-- Vertical 2: QPA methodology substantiation & audit-response templates (federal)
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,last_verified_at,verified_by,source_url)
SELECT v.code,v.citation,nullif(v.mirrors,''),v.topic,'verified',true,0.95,now(),'claude-web 2026-07-10',v.src
FROM (VALUES
  ('NSA_QPA_METHODOLOGY','45 CFR §149.140(b)-(c)','26 CFR §54.9816-6T; 29 CFR §2590.716-6','QPA calculation methodology (median contracted rate & CPI-U indexing)','https://www.ecfr.gov/current/title-45/part-149/section-149.140'),
  ('NSA_QPA_AUDIT','45 CFR §149.140(e)-(g)','26 CFR §54.9816-6T; 29 CFR §2590.716-6','QPA eligible databases, audit & applicability','https://www.ecfr.gov/current/title-45/part-149/section-149.140')
) v(code,citation,mirrors,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='qpa_methodology_defense';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'qpa_methodology_defense','qpa_methodology_defense','QPA methodology substantiation — {{dispute.external_ref}}',
      'Substantiates how the QPA was calculated (median contracted rate, CPI-U indexing, eligible database, new-code rules) for IDR or an information request.','federal')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'caption','<p class="doc-meta">{{date.today}}</p><p style="text-align:center"><strong>QUALIFYING PAYMENT AMOUNT &mdash; METHODOLOGY SUBSTANTIATION</strong></p>',NULL,NULL),
      (tid,15,'parties','<p><strong>{{dispute.plan_legal_name}}</strong> &middot; {{dispute.reference}} &middot; CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}</p>',NULL,NULL),
      (tid,20,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) provides this substantiation of the Qualifying Payment Amount (QPA) for the item in dispute, {{money.qpa}}, determined in accordance with {{cite.NSA_QPA_METHODOLOGY}}.</p>',NULL,NULL),
      (tid,30,'median','<p>The Plan calculated the median contracted rate for the same or similar item or service in the applicable geographic region under 45 CFR §149.140(b), arranging the Plan&rsquo;s contracted rates as of the relevant date and selecting the median in accordance with the pooling and specialty rules.</p>',NULL,NULL),
      (tid,40,'indexing','<p>The median contracted rate was indexed to the applicable year using the change in the Consumer Price Index for All Urban Consumers (CPI-U) as required by 45 CFR §149.140(c)(1), yielding the QPA of {{money.qpa}} ({{qpa.methodology}}).</p>',NULL,NULL),
      (tid,50,'database','<p>Because the Plan had insufficient information to calculate a median contracted rate, the QPA was determined using an eligible database in accordance with 45 CFR §149.140(c)(3).</p>','{"answer":"used_database","equals":true}',NULL),
      (tid,60,'newcode','<p>For this new service code, the QPA was derived from a related service code and the applicable Medicare payment ratio in accordance with 45 CFR §149.140(c)(4).</p>','{"answer":"new_service_code","equals":true}',NULL),
      (tid,70,'disclosure','<p>The Plan disclosed the QPA and the required accompanying information under {{cite.NSA_QPA_DISCLOSURE}}, and, where any code was changed, the downcoding disclosure required by {{cite.NSA_QPA_DOWNCODE}}.</p>',NULL,NULL),
      (tid,80,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,90,'conclusion','<p>The QPA of {{money.qpa}} was determined in accordance with the governing methodology and is properly supported.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'used_database','QPA set from an eligible database (insufficient info)','boolean',NULL,'false'::jsonb,false,false),
      (tid,40,'new_service_code','New service code (derived via Medicare ratio)','boolean',NULL,'false'::jsonb,false,false),
      (tid,50,'extra_argument','Additional detail (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;

  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='qpa_audit_response';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'qpa_audit_response','qpa_audit_response','QPA audit response — {{dispute.external_ref}}',
      'Response to a regulator or provider QPA information request/audit demonstrating compliant methodology and disclosures.','federal')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'caption','<p class="doc-meta">{{date.today}}</p><p style="text-align:center"><strong>RESPONSE TO QPA INFORMATION REQUEST / AUDIT</strong></p>',NULL,NULL),
      (tid,15,'parties','<p><strong>{{dispute.plan_legal_name}}</strong> &middot; {{dispute.reference}} &middot; CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}}</p>',NULL,NULL),
      (tid,20,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this response concerning the Qualifying Payment Amount for the item identified above and demonstrates compliance with {{cite.NSA_QPA_METHODOLOGY}} and the recordkeeping and audit provisions of {{cite.NSA_QPA_AUDIT}}.</p>',NULL,NULL),
      (tid,30,'methodology','<p>The QPA of {{money.qpa}} was calculated using the median contracted rate methodology and CPI-U indexing under 45 CFR §149.140(b)-(c), and the underlying rate data and calculation records are retained and available for audit.</p>',NULL,NULL),
      (tid,40,'disclosure','<p>The Plan provided the QPA disclosures required by {{cite.NSA_QPA_DISCLOSURE}} at the time of the initial payment or notice of denial.</p>',NULL,NULL),
      (tid,50,'records','<p>The following records are provided in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,60,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,90,'conclusion','<p>The Plan&rsquo;s QPA determination for this item complies with the governing methodology and disclosure requirements.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'extra_argument','Additional detail (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;
END $$;
