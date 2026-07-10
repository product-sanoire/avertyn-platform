-- Bucket 2 build (2): payment-integrity CLAIM SCANNER — findings table + stateless prescreen + dispute-writing scan + read RPC
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10 (mirror). Mirrors eligibility_findings/run_eligibility. Additive; own RLS.

ALTER TABLE public.disputes ADD COLUMN IF NOT EXISTS pi_score integer;

CREATE TABLE IF NOT EXISTS public.payment_integrity_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  dispute_id uuid NOT NULL,
  rule_id uuid REFERENCES public.payment_integrity_rules(id),
  code text,
  result text NOT NULL DEFAULT 'flag',
  confidence numeric,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pif_dispute_idx ON public.payment_integrity_findings(dispute_id);

ALTER TABLE public.payment_integrity_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pif_org ON public.payment_integrity_findings;
CREATE POLICY pif_org ON public.payment_integrity_findings FOR SELECT
  USING (public.auth_org_id() IS NULL OR org_id = public.auth_org_id());
GRANT SELECT ON public.payment_integrity_findings TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.prescreen_payment_integrity(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  findings jsonb := '[]'::jsonb; n_flags int := 0; s int; band text; rec text;
  v_units int := (p_payload->>'units')::int;
  v_mue int := (p_payload->>'mue_limit')::int;
  b_paired boolean := (p_payload->>'paired_component')::boolean;
  b_drg_unsupported boolean := ((p_payload->>'drg_supported') is not null and (p_payload->>'drg_supported')::boolean = false);
  b_dup boolean := (p_payload->>'duplicate')::boolean;
  b_up boolean := (p_payload->>'em_upcoded')::boolean;
  b_mod boolean := (p_payload->>'modifier_unsupported')::boolean;
  b_nc boolean := (p_payload->>'noncovered')::boolean;
  r record;
begin
  for r in select code, hit from (values
      ('NCCI_PTP', coalesce(b_paired,false)),
      ('MUE_UNITS', (v_units is not null and v_mue is not null and v_units > v_mue)),
      ('DRG_VALIDATION', coalesce(b_drg_unsupported,false)),
      ('DUP_CLAIM_LINE', coalesce(b_dup,false)),
      ('EM_UPCODE', coalesce(b_up,false)),
      ('MODIFIER_MISUSE', coalesce(b_mod,false)),
      ('NONCOVERED', coalesce(b_nc,false))
    ) as t(code, hit)
  loop
    if r.hit then
      n_flags := n_flags + 1;
      findings := findings || (select jsonb_build_object('code',pir.code,'name',pir.name,'category',pir.category,'result','flag','detail',pir.argument)
        from public.payment_integrity_rules pir where pir.code = r.code);
    end if;
  end loop;
  if n_flags >= 2 then s := 80; elsif n_flags = 1 then s := 55; else s := 10; end if;
  if s >= 50 then band := 'recovery'; rec := 'adjust_or_deny'; else band := 'clean'; rec := 'pay'; end if;
  return jsonb_build_object('pi_score',s,'band',band,'recommendation',rec,'flags',n_flags,'findings',findings,
    'model','avertyn-payment-integrity-v1','scored_at',now());
end $function$;
GRANT EXECUTE ON FUNCTION public.prescreen_payment_integrity(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_payment_integrity(p_dispute uuid, p_payload jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  d record; r record; n_flags int := 0; s int;
  v_units int := (p_payload->>'units')::int;
  v_mue int := (p_payload->>'mue_limit')::int;
  b_paired boolean := (p_payload->>'paired_component')::boolean;
  b_drg_unsupported boolean := ((p_payload->>'drg_supported') is not null and (p_payload->>'drg_supported')::boolean = false);
  b_dup boolean := (p_payload->>'duplicate')::boolean;
  b_up boolean := (p_payload->>'em_upcoded')::boolean;
  b_mod boolean := (p_payload->>'modifier_unsupported')::boolean;
  b_nc boolean := (p_payload->>'noncovered')::boolean;
begin
  select * into d from public.disputes where id = p_dispute;
  if not found then return null; end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then
    raise exception 'not authorized for this dispute';
  end if;
  delete from public.payment_integrity_findings where dispute_id = p_dispute;
  for r in select code, hit from (values
      ('NCCI_PTP', coalesce(b_paired,false)),
      ('MUE_UNITS', (v_units is not null and v_mue is not null and v_units > v_mue)),
      ('DRG_VALIDATION', coalesce(b_drg_unsupported,false)),
      ('DUP_CLAIM_LINE', coalesce(b_dup,false)),
      ('EM_UPCODE', coalesce(b_up,false)),
      ('MODIFIER_MISUSE', coalesce(b_mod,false)),
      ('NONCOVERED', coalesce(b_nc,false))
    ) as t(code, hit)
  loop
    if r.hit then
      n_flags := n_flags + 1;
      insert into public.payment_integrity_findings (org_id, dispute_id, rule_id, code, result, confidence, detail)
      select d.org_id, p_dispute, pir.id, pir.code, 'flag', 0.8, pir.argument
      from public.payment_integrity_rules pir where pir.code = r.code;
    end if;
  end loop;
  if n_flags >= 2 then s := 80; elsif n_flags = 1 then s := 55; else s := 10; end if;
  update public.disputes set pi_score = s where id = p_dispute;
  return s;
end $function$;
GRANT EXECUTE ON FUNCTION public.run_payment_integrity(uuid, jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_payment_integrity(p_dispute uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare d_org uuid;
begin
  select org_id into d_org from public.disputes where id = p_dispute;
  if d_org is null then return '[]'::jsonb; end if;
  if public.auth_org_id() is not null and d_org <> public.auth_org_id() then
    raise exception 'not authorized for this dispute';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('code',f.code,'result',f.result,'confidence',f.confidence,
      'detail',f.detail,'created_at',f.created_at) order by f.created_at)
    from public.payment_integrity_findings f where f.dispute_id = p_dispute), '[]'::jsonb);
end $function$;
GRANT EXECUTE ON FUNCTION public.get_payment_integrity(uuid) TO anon, authenticated;
