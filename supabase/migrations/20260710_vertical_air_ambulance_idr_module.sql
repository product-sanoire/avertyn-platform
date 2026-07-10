-- Vertical 3: Air-ambulance Federal IDR module (§149.520 factors; ADA-preemption federal-only)
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,last_verified_at,verified_by,source_url)
SELECT v.code,v.citation,nullif(v.mirrors,''),v.topic,'verified',true,0.90,now(),'claude-web 2026-07-10',nullif(v.src,'')
FROM (VALUES
  ('NSA_AIR_IDR','45 CFR §149.520','26 CFR §54.9817-2T; 29 CFR §2590.717-2','Air-ambulance Federal IDR process','https://www.ecfr.gov/current/title-45/part-149/section-149.520'),
  ('NSA_AIR_FACTORS','45 CFR §149.520(b)(2)','','Air-ambulance IDR additional factors','https://www.ecfr.gov/current/title-45/part-149/section-149.520'),
  ('NSA_AIR_BALANCE','45 CFR §149.440','','Air-ambulance balance-billing protection','https://www.ecfr.gov/current/title-45/part-149/section-149.440'),
  ('ADA_PREEMPTION','Airline Deregulation Act, 49 U.S.C. §41713(b)(1)','','ADA preemption of state air-ambulance rate regulation','')
) v(code,citation,mirrors,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.eligibility_rules(code,name,description,category,severity,authority,argument,authority_code,jurisdiction)
SELECT v.code,v.name,v.descr,v.cat,v.sev,v.auth,v.arg,v.acode,'federal'
FROM (VALUES
  ('AIR_QUALIFIED','Qualified air-ambulance service','OON/emergency air ambulance is a qualified IDR item','qualified_item','disqualifying',
   '45 CFR §149.520',
   'Out-of-network or emergency air-ambulance service is a qualified item for the Federal IDR process under 45 CFR §149.520.',
   'NSA_AIR_IDR'),
  ('AIR_ADA_FEDERAL','Air ambulance is Federal-only (ADA preemption)','No specified State law can set air-ambulance rates','jurisdiction','warning',
   '49 U.S.C. §41713(b)(1)',
   'Because the Airline Deregulation Act preempts state regulation of air-ambulance rates, no specified State law applies; the dispute belongs in the Federal IDR process under 45 CFR §149.520 and a state-jurisdiction objection does not lie.',
   'ADA_PREEMPTION'),
  ('AIR_FACTORS','Air-ambulance §149.520(b)(2) factors','IDRE weighs vehicle type, pickup density, acuity, crew, quality, good-faith','qualified_item','warning',
   '45 CFR §149.520(b)(2)',
   'The certified IDR entity first considers the QPA and then weighs the air-ambulance factors under 45 CFR §149.520(b)(2): quality and outcomes, patient acuity and service complexity, training and experience of the medical personnel, ambulance vehicle type and clinical capability, population density of the point of pick-up, and good-faith network efforts.',
   'NSA_AIR_FACTORS')
) v(code,name,descr,cat,sev,auth,arg,acode)
WHERE NOT EXISTS (SELECT 1 FROM public.eligibility_rules er WHERE er.code=v.code);

DO $$
DECLARE tid uuid;
BEGIN
  SELECT id INTO tid FROM public.document_templates WHERE org_id IS NULL AND code='air_ambulance_position';
  IF tid IS NULL THEN
    INSERT INTO public.document_templates(org_id,code,kind,title,description,jurisdiction)
    VALUES(NULL,'air_ambulance_position','air_ambulance_position','Air-ambulance IDR position — {{dispute.external_ref}}',
      'Plan position statement for the air-ambulance Federal IDR process addressing the §149.520(b)(2) factors.','federal')
    RETURNING id INTO tid;
    INSERT INTO public.template_clauses(template_id,seq,key,body,include_when,repeat_over) VALUES
      (tid,10,'letterhead','<p class="doc-meta">{{date.today}}</p><p><strong>Re: Plan position statement &mdash; Air-ambulance Federal IDR {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',NULL,NULL),
      (tid,20,'salutation','<p>To the Certified IDR Entity:</p>',NULL,NULL),
      (tid,30,'intro','<p>{{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;) submits this position statement for the air-ambulance item in dispute under the Federal IDR process for air-ambulance services ({{cite.NSA_AIR_IDR}}) and requests that the certified IDR entity select the Plan&rsquo;s offer at or near the Qualifying Payment Amount.</p>',NULL,NULL),
      (tid,40,'standard','<p>Under {{cite.NSA_AIR_FACTORS}}, the certified IDR entity first considers the QPA and then weighs the air-ambulance factors; no factor, including the QPA, is controlling. Properly weighed, those factors support the QPA.</p>',NULL,NULL),
      (tid,50,'offer','<p>The Plan&rsquo;s QPA for this item is {{money.qpa}}, determined using the {{qpa.methodology}}. The initiating party&rsquo;s demand of {{money.demand}} reflects billed charges rather than the recognized market rate.</p>',NULL,NULL),
      (tid,55,'jurisdiction','<p>Air-ambulance rates are not subject to state regulation; under {{cite.NSA_AIR_IDR}} this dispute is properly before the Federal IDR process.</p>',NULL,NULL),
      (tid,60,'benchmarks','<p>The Plan&rsquo;s QPA is corroborated by independent reference points:</p>{{qpa.benchmark_table}}','{"answer":"include_benchmarks","equals":true}',NULL),
      (tid,70,'f_vehicle','<p>The ambulance vehicle type and its clinical capability level are already reflected in the applicable service coding and the QPA and do not warrant a rate above the QPA.</p>','{"answer":"vehicle_type"}',NULL),
      (tid,72,'f_density','<p>The population density of the point of pick-up does not justify a departure above the QPA; the QPA already reflects the geographic market for this service.</p>','{"answer":"pickup_density"}',NULL),
      (tid,74,'f_quality','<p>The acuity, crew training, and quality considerations are reflected in the QPA and the service coding; nothing in the record warrants a rate above the QPA on those grounds.</p>','{"answer":"emphasis","equals":"quality"}',NULL),
      (tid,76,'f_goodfaith','<p>The Plan has made good-faith efforts to contract with air-ambulance providers at market rates; the provider&rsquo;s decision to remain out-of-network does not support a rate above the QPA.</p>','{"answer":"emphasis","equals":"goodfaith"}',NULL),
      (tid,80,'extra','<p>{{answers.extra_argument}}</p>','{"answer":"extra_argument"}',NULL),
      (tid,88,'exhibits','<p>The following materials are submitted in support and incorporated by reference:</p>{{exhibits}}','{"flag":"has_evidence"}',NULL),
      (tid,90,'request','<p>For these reasons, the Plan respectfully requests that the certified IDR entity select the Plan&rsquo;s offer at or near the QPA of {{money.qpa}}.</p>',NULL,NULL),
      (tid,95,'signature','<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',NULL,NULL);
    INSERT INTO public.template_questions(template_id,seq,key,prompt,input_type,options,default_val,required,ai_assist) VALUES
      (tid,10,'signer_name','Signer name','text',NULL,NULL,true,false),
      (tid,20,'signer_title','Signer title','text',NULL,'"Authorized Plan Representative"'::jsonb,false,false),
      (tid,30,'vehicle_type','Ambulance vehicle type','select','[{"label":"Fixed-wing","value":"fixed_wing"},{"label":"Rotary-wing","value":"rotary_wing"}]'::jsonb,NULL,false,false),
      (tid,40,'pickup_density','Point-of-pickup density','select','[{"label":"Urban","value":"urban"},{"label":"Suburban","value":"suburban"},{"label":"Rural","value":"rural"},{"label":"Frontier","value":"frontier"}]'::jsonb,NULL,false,false),
      (tid,50,'emphasis','Primary factor to emphasize','select','[{"label":"QPA + market rates","value":"qpa"},{"label":"Quality / crew / acuity","value":"quality"},{"label":"Good-faith network efforts","value":"goodfaith"}]'::jsonb,'"qpa"'::jsonb,false,false),
      (tid,60,'include_benchmarks','Include benchmark table','boolean',NULL,'true'::jsonb,false,false),
      (tid,70,'extra_argument','Additional argument (optional)','textarea',NULL,'""'::jsonb,false,true);
  END IF;
END $$;
