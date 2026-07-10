-- Vertical 1d: State rulebook — Georgia + Colorado + Virginia + Florida
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB).
-- Additive only; state citations status='unverified' pending counsel review.
INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,effective_note,source_url)
SELECT v.code,v.citation,NULL,v.topic,'unverified',true,0.6,
       'State-law citation — confirm exact subsection and current deadlines/thresholds with counsel before a live filing.',v.src
FROM (VALUES
  ('GA_SBCPA','O.C.G.A. Title 33, Ch. 20E (Surprise Billing Consumer Protection Act)','GA surprise-billing arbitration','https://law.justia.com/codes/georgia/title-33/chapter-20e/'),
  ('GA_ARB','O.C.G.A. §33-20E-9 (arbitration of payment issues; FAIR Health data)','GA baseball arbitration','https://law.justia.com/codes/georgia/title-33/chapter-20e/section-33-20e-9/'),
  ('CO_OON','C.R.S. §10-16-704; §12-30-113 (out-of-network billing)','CO out-of-network payment & arbitration','https://law.justia.com/codes/colorado/title-10/health-care-coverage/article-16/part-7/section-10-16-704/'),
  ('CO_STD','C.R.S. §10-16-704 (60th percentile in-network or 105% of median in-network)','CO OON payment standard','https://doi.colorado.gov/types-of-insurance/health-insurance/health-insurance-initiatives/federal-no-surprises-act/colorado'),
  ('VA_BB','Code of Va. §38.2-3445.01 (balance billing prohibited)','VA balance-billing protection','https://law.lis.virginia.gov/vacode/title38.2/chapter34/section38.2-3445.01/'),
  ('VA_ARB','Code of Va. §38.2-3445.02 (arbitration; commercially reasonable)','VA balance-billing arbitration','https://law.lis.virginia.gov/vacode/title38.2/chapter34/section38.2-3445.02/'),
  ('FL_OON','Fla. Stat. §627.64194 (OON payment)','FL out-of-network payment','https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0600-0699/0627/Sections/0627.64194.html'),
  ('FL_CDRP','Fla. Stat. §408.7057 (Statewide Provider and Health Plan Claim Dispute Resolution Program)','FL claim dispute resolution program','https://fcep.org/fall-2020-medical-economics-florida-balance-billing-oon-dispute-resolution-summary/')
) v(code,citation,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.eligibility_rules(code,name,description,category,severity,authority,argument,authority_code,jurisdiction)
SELECT v.code,v.name,v.descr,v.cat,v.sev,v.auth,v.arg,v.acode,v.jur
FROM (VALUES
  ('GA_JUR_APPLIES','GA SBCPA jurisdiction','Fully-insured GA claim governed by the SBCPA, not Federal IDR','jurisdiction','disqualifying',
   'O.C.G.A. Ch. 20E; 45 CFR §149.30',
   'This fully-insured Georgia out-of-network claim is governed by the Surprise Billing Consumer Protection Act (O.C.G.A. Ch. 20E), a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'GA_SBCPA','GA'),
  ('GA_ARB_BASEBALL','GA final-offer arbitration','Arbitrator selects one party&rsquo;s offer using FAIR Health data','qualified_item','warning',
   'O.C.G.A. §33-20E-9',
   'Georgia arbitration is final-offer style: the arbitrator selects the more reasonable offer, informed by FAIR Health benchmark data; the Plan&rsquo;s offer at the market rate should be selected.',
   'GA_ARB','GA'),
  ('CO_JUR_APPLIES','CO §10-16-704 jurisdiction','Fully-insured CO claim governed by the CO OON law, not Federal IDR','jurisdiction','disqualifying',
   'C.R.S. §10-16-704; 45 CFR §149.30',
   'This fully-insured Colorado out-of-network claim is governed by C.R.S. §10-16-704, a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'CO_OON','CO'),
  ('CO_STD_PAY','CO OON payment standard','Payment = 60th pct in-network or 105% of median in-network','qualified_item','warning',
   'C.R.S. §10-16-704',
   'Under Colorado law the out-of-network payment is set by reference to the 60th percentile of in-network rates or 105% of the median in-network rate; the Plan&rsquo;s payment at that standard is compliant.',
   'CO_STD','CO'),
  ('VA_JUR_APPLIES','VA §38.2-3445 jurisdiction','Fully-insured VA claim governed by the VA balance-billing law, not Federal IDR','jurisdiction','disqualifying',
   'Code of Va. §38.2-3445.01; 45 CFR §149.30',
   'This fully-insured Virginia out-of-network claim is governed by Code of Va. §38.2-3445.01 et seq., a specified State law under 45 CFR §149.30, so the Federal IDR process does not apply.',
   'VA_BB','VA'),
  ('VA_ARB_COMMRE','VA commercially-reasonable arbitration','Baseball arbitration on a commercially reasonable amount','qualified_item','warning',
   'Code of Va. §38.2-3445.02',
   'Virginia arbitration is final-offer style on a commercially reasonable amount, weighing statutory factors; the Plan&rsquo;s offer at the market rate should be selected.',
   'VA_ARB','VA'),
  ('FL_JUR_APPLIES','FL claim-dispute jurisdiction','FL OON claim routed to the statewide claim dispute program','jurisdiction','warning',
   'Fla. Stat. §627.64194; §408.7057',
   'This Florida out-of-network claim is addressed by Fla. Stat. §627.64194 and the Statewide Provider and Health Plan Claim Dispute Resolution Program (§408.7057); confirm whether the Florida program or the Federal IDR process governs this claim.',
   'FL_CDRP','FL'),
  ('FL_PROGRAM','FL statewide claim dispute program','Resolution via the §408.7057 program (administered by the state contractor)','qualified_item','warning',
   'Fla. Stat. §408.7057',
   'Florida resolves these disputes through the Statewide Provider and Health Plan Claim Dispute Resolution Program; the Plan&rsquo;s payment at the recognized market rate is supported before the program reviewer.',
   'FL_CDRP','FL')
) v(code,name,descr,cat,sev,auth,arg,acode,jur)
WHERE NOT EXISTS (SELECT 1 FROM public.eligibility_rules er WHERE er.code=v.code);

-- Templates ga_arbitration_position, co_arbitration_position, va_arbitration_position, fl_claim_dispute_position
-- were seeded live via DO-block (same clause/question pattern as the NY/TX state templates); the live DB is the
-- source of truth. Re-running this file inserts authorities + rules idempotently; template DO-block omitted here for
-- brevity and is preserved in the migration transcript.
