-- Bucket 2 build: payment-integrity foundation (new reference table + seed + list RPC + determination template)
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror of the live DB). Additive; own RLS.

CREATE TABLE IF NOT EXISTS public.payment_integrity_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  description text,
  authority text,
  authority_code text,
  argument text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_integrity_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pir_read ON public.payment_integrity_rules;
CREATE POLICY pir_read ON public.payment_integrity_rules FOR SELECT USING (true);
GRANT SELECT ON public.payment_integrity_rules TO anon, authenticated;

INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,last_verified_at,verified_by,source_url)
SELECT v.code,v.citation,NULL,v.topic,'verified',true,0.9,now(),'claude-web 2026-07-10',v.src
FROM (VALUES
  ('CMS_NCCI','CMS National Correct Coding Initiative (NCCI) Policy Manual','Correct coding / unbundling (PTP edits)','https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits'),
  ('CMS_MUE','CMS Medically Unlikely Edits (MUE)','Units-of-service edits','https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits'),
  ('CMS_DRG','CMS MS-DRG definitions (IPPS)','DRG validation','https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps')
) v(code,citation,topic,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.payment_integrity_rules(code,name,category,description,authority,authority_code,argument)
SELECT v.code,v.name,v.cat,v.descr,v.auth,v.acode,v.arg
FROM (VALUES
  ('NCCI_PTP','NCCI unbundling (PTP edit)','unbundling','Procedure-to-procedure edit: a component code billed separately with its comprehensive code',
   'CMS NCCI Policy Manual','CMS_NCCI',
   'The billed code pair is a Procedure-to-Procedure edit under the CMS NCCI Policy Manual; the component service is bundled into the comprehensive service and is not separately payable absent an appropriate modifier.'),
  ('MUE_UNITS','Units exceed MUE','units','Units of service exceed the CMS Medically Unlikely Edit for the code',
   'CMS Medically Unlikely Edits','CMS_MUE',
   'The units billed exceed the CMS Medically Unlikely Edit value for this code; the excess units are not payable absent documentation supporting a permitted exception.'),
  ('DRG_VALIDATION','DRG validation','drg','Coded DRG not supported by the documented diagnoses/procedures',
   'CMS MS-DRG definitions','CMS_DRG',
   'The assigned DRG is not supported by the documented principal and secondary diagnoses and procedures; the claim is adjusted to the correctly validated DRG.'),
  ('DUP_CLAIM_LINE','Duplicate claim / line','duplicate','Same service, provider, and date already adjudicated',
   'Correct coding','CMS_NCCI',
   'This line duplicates a service already adjudicated for the same provider, member, code, and date of service, and is not separately payable.'),
  ('EM_UPCODE','E/M level upcoding','upcoding','E/M level billed exceeds the documented history/exam/MDM',
   'CMS E/M documentation guidelines','CMS_NCCI',
   'The evaluation-and-management level billed exceeds the level supported by the documented medical decision making; the service is adjusted to the supported level.'),
  ('MODIFIER_MISUSE','Modifier 25/59 misuse','modifier','Bypass modifier used without a separately identifiable service',
   'CMS NCCI Policy Manual','CMS_NCCI',
   'The bypass modifier (e.g., 25 or 59) was appended without a separately identifiable service supporting its use; the associated line is subject to the underlying edit.'),
  ('NONCOVERED','Non-covered / experimental','noncovered','Service is investigational, experimental, or otherwise non-covered',
   'Plan document / SPD','RBP_PLAN_TERMS',
   'The service is investigational, experimental, or otherwise excluded under the plan document and is not a covered benefit.')
) v(code,name,cat,descr,auth,acode,arg)
WHERE NOT EXISTS (SELECT 1 FROM public.payment_integrity_rules pir WHERE pir.code=v.code);

CREATE OR REPLACE FUNCTION public.list_payment_integrity_rules()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',code,'name',name,'category',category,'description',description,
           'authority',authority,'authority_code',authority_code,'argument',argument) order by category, name), '[]'::jsonb)
  from payment_integrity_rules where active;
$f$;
GRANT EXECUTE ON FUNCTION public.list_payment_integrity_rules() TO anon, authenticated;

-- Template payment_integrity_determination (federal) seeded live via DO-block: caption/parties/intro, per-category
-- basis clauses gated on {"answer":"edit_category","equals":<unbundling|units|drg|duplicate|upcoding|modifier|noncovered>}
-- citing CMS_NCCI / CMS_MUE / CMS_DRG / RBP_PLAN_TERMS, plus rationale/adjustment/conclusion/signature. Questions:
-- signer_name, signer_title, edit_category (select), rationale (textarea, ai_assist). Live DB is source of truth.
