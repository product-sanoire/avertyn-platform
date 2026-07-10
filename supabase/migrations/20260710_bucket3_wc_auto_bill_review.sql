-- Bucket 3: Workers'-comp & Auto (PIP) medical bill review — new line of business
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror). Additive; own RLS.

CREATE TABLE IF NOT EXISTS public.bill_review_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  line_of_business text NOT NULL,
  category text NOT NULL,
  description text,
  authority text,
  authority_code text,
  argument text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bill_review_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brr_read ON public.bill_review_rules;
CREATE POLICY brr_read ON public.bill_review_rules FOR SELECT USING (true);
GRANT SELECT ON public.bill_review_rules TO anon, authenticated;

INSERT INTO public.legal_authorities(code,citation,mirrors,topic,status,operative,confidence,last_verified_at,verified_by,effective_note,source_url)
SELECT v.code,v.citation,NULL,v.topic,v.status,true,v.conf,
       CASE WHEN v.status='verified' THEN now() ELSE NULL END,
       CASE WHEN v.status='verified' THEN 'claude-web 2026-07-10' ELSE NULL END, v.note,v.src
FROM (VALUES
  ('OWCP_FEE','OWCP medical fee schedule (20 CFR §10.809; 5 U.S.C. §8103)','Federal workers-comp (OWCP) fee schedule','verified',0.85,'','https://www.dol.gov/agencies/owcp/regs/feeschedule/fee'),
  ('WC_FEE_SCHED','State workers-compensation medical fee schedule (state-specific)','State WC fee schedule / reimbursement','unverified',0.5,'Cite the applicable state WC fee schedule and edition; confirm before use.',''),
  ('AUTO_PIP','State auto no-fault / PIP medical fee schedule (state-specific)','Auto PIP medical fee schedule','unverified',0.5,'Cite the applicable state PIP/no-fault fee schedule; confirm before use.',''),
  ('TREAT_GUIDE','Evidence-based treatment guidelines (e.g., ODG, ACOEM, state MTUS)','WC/auto treatment guidelines','unverified',0.5,'Cite the applicable guideline set adopted by the jurisdiction; confirm before use.','')
) v(code,citation,topic,status,conf,note,src)
WHERE NOT EXISTS (SELECT 1 FROM public.legal_authorities la WHERE la.code=v.code);

INSERT INTO public.bill_review_rules(code,name,line_of_business,category,description,authority,authority_code,argument)
SELECT v.code,v.name,v.lob,v.cat,v.descr,v.auth,v.acode,v.arg
FROM (VALUES
  ('WC_FEE_REDUCE','WC fee-schedule reduction','wc','fee_schedule','Billed amount exceeds the workers-comp fee-schedule allowable',
   'State WC fee schedule','WC_FEE_SCHED',
   'The billed amount exceeds the applicable workers-compensation fee-schedule allowable; payment is reduced to the fee-schedule amount, which the provider must accept as payment in full.'),
  ('OWCP_FEE_REDUCE','OWCP fee-schedule reduction','wc','fee_schedule','Federal (OWCP) claim exceeds the OWCP fee-schedule allowable',
   'OWCP fee schedule','OWCP_FEE',
   'The billed amount exceeds the OWCP medical fee-schedule maximum allowable under 20 CFR §10.809; payment is reduced to the scheduled amount.'),
  ('AUTO_FEE_REDUCE','Auto PIP fee-schedule reduction','auto','fee_schedule','Billed amount exceeds the auto PIP fee-schedule / statutory limit',
   'State PIP fee schedule','AUTO_PIP',
   'The billed amount exceeds the applicable auto no-fault/PIP fee-schedule limit; payment is reduced to the scheduled amount.'),
  ('BR_UNBUNDLE','Unbundling (NCCI)','wc','unbundling','Component code billed with its comprehensive code',
   'CMS NCCI Policy Manual','CMS_NCCI',
   'The billed code pair is a Procedure-to-Procedure edit under the CMS NCCI Policy Manual, applied in bill review; the component service is bundled and not separately payable absent an appropriate modifier.'),
  ('BR_DUPLICATE','Duplicate bill','wc','duplicate','Same service, provider and date already paid',
   'Bill review','WC_FEE_SCHED',
   'This bill duplicates a service already adjudicated for the same provider, claimant, code, and date of service, and is not separately payable.'),
  ('BR_UNRELATED','Unrelated to injury','wc','unrelated','Treatment not causally related to the compensable injury',
   'State WC fee schedule','WC_FEE_SCHED',
   'The treatment billed is not causally related to the accepted compensable injury and is not payable under the claim.'),
  ('BR_GUIDELINE','Exceeds treatment guidelines','wc','guideline','Treatment exceeds evidence-based guideline recommendations',
   'Evidence-based treatment guidelines','TREAT_GUIDE',
   'The treatment billed exceeds the frequency or duration supported by the applicable evidence-based treatment guidelines and is reduced or denied to the guideline-supported level.'),
  ('BR_BALANCE','Prohibited balance bill','wc','balance_bill','Provider balance-billed the injured worker / claimant',
   'State WC fee schedule','WC_FEE_SCHED',
   'The provider improperly balance-billed the claimant; under the fee schedule the scheduled amount is payment in full and balance billing is prohibited.')
) v(code,name,lob,cat,descr,auth,acode,arg)
WHERE NOT EXISTS (SELECT 1 FROM public.bill_review_rules brr WHERE brr.code=v.code);

CREATE OR REPLACE FUNCTION public.list_bill_review_rules(p_lob text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  select coalesce(jsonb_agg(jsonb_build_object('code',code,'name',name,'line_of_business',line_of_business,'category',category,
           'description',description,'authority',authority,'authority_code',authority_code,'argument',argument)
           order by line_of_business, category, name), '[]'::jsonb)
  from bill_review_rules where active and (p_lob is null or line_of_business = p_lob);
$f$;
GRANT EXECUTE ON FUNCTION public.list_bill_review_rules(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.prescreen_bill_review(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  findings jsonb := '[]'::jsonb; n_flags int := 0; band text; rec text;
  v_lob text := lower(coalesce(p_payload->>'line_of_business','wc'));
  v_billed numeric := (p_payload->>'billed_amount')::numeric;
  v_allowed numeric := (p_payload->>'fee_schedule_allowed')::numeric;
  b_over boolean := (v_billed is not null and v_allowed is not null and v_billed > v_allowed);
  b_dup boolean := (p_payload->>'duplicate')::boolean;
  b_unrel boolean := (p_payload->>'unrelated')::boolean;
  b_guide boolean := (p_payload->>'exceeds_guideline')::boolean;
  b_unb boolean := (p_payload->>'unbundled')::boolean;
  b_bal boolean := (p_payload->>'balance_billed')::boolean;
  v_reduction numeric := 0; r record;
begin
  for r in select code, hit from (values
      (case when v_lob='auto' then 'AUTO_FEE_REDUCE' else 'WC_FEE_REDUCE' end, coalesce(b_over,false)),
      ('BR_UNBUNDLE', coalesce(b_unb,false)),
      ('BR_DUPLICATE', coalesce(b_dup,false)),
      ('BR_UNRELATED', coalesce(b_unrel,false)),
      ('BR_GUIDELINE', coalesce(b_guide,false)),
      ('BR_BALANCE', coalesce(b_bal,false))
    ) as t(code, hit)
  loop
    if r.hit then
      n_flags := n_flags + 1;
      findings := findings || (select jsonb_build_object('code',brr.code,'name',brr.name,'category',brr.category,'result','flag','detail',brr.argument)
        from public.bill_review_rules brr where brr.code = r.code);
    end if;
  end loop;
  if b_over then v_reduction := v_billed - v_allowed; end if;
  if n_flags >= 2 then band := 'high_reduction'; rec := 'reduce_or_deny';
  elsif n_flags = 1 then band := 'reduction'; rec := 'reduce';
  else band := 'clean'; rec := 'pay'; end if;
  return jsonb_build_object('line_of_business',v_lob,'flags',n_flags,'band',band,'recommendation',rec,
    'allowed_amount',v_allowed,'fee_schedule_reduction',v_reduction,'findings',findings,
    'model','avertyn-bill-review-v1','scored_at',now());
end $function$;
GRANT EXECUTE ON FUNCTION public.prescreen_bill_review(jsonb) TO anon, authenticated;

-- Template bill_review_determination (jurisdiction 'WC_AUTO') seeded live via DO-block: caption/parties/intro,
-- per-category basis clauses gated on review_category (+ line_of_business for fee_schedule) citing
-- WC_FEE_SCHED/AUTO_PIP/CMS_NCCI/TREAT_GUIDE, plus rationale/adjustment/conclusion/signature. Questions:
-- signer_name, signer_title, line_of_business (select wc/auto), review_category (select), rationale (textarea).
-- Live DB is source of truth for the template rows.
