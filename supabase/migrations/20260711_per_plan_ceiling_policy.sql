-- Per-plan (with org default) defensible-ceiling policy.
-- A TPA can greenlight a ceiling per plan as a % of QPA or a flat amount; it flows
-- into qpa_records.defensible_ceiling and therefore into predict_win's offer cap,
-- the negotiation strategy anchors, and generated documents. Resolution precedence:
--   per-case override (disputes.ceiling_override) > plan policy > org default > global 125%.
-- Plan ceilings are allowed ABOVE the regional benchmark but flagged (ceiling_above_benchmark).

-- 1) Schema -------------------------------------------------------------------
alter table public.plans
  add column if not exists ceiling_mode text check (ceiling_mode in ('pct_of_qpa','amount')),
  add column if not exists ceiling_value numeric,
  add column if not exists ceiling_updated_at timestamptz,
  add column if not exists ceiling_updated_by text;

alter table public.orgs
  add column if not exists ceiling_mode text check (ceiling_mode in ('pct_of_qpa','amount')),
  add column if not exists ceiling_value numeric;

alter table public.qpa_records
  add column if not exists ceiling_source text,                              -- manual_override | plan_policy | org_default | global_default
  add column if not exists ceiling_above_benchmark boolean not null default false;

-- 2) compute_qpa_defense: resolve the ceiling policy, flag above-benchmark ------
CREATE OR REPLACE FUNCTION public.compute_qpa_defense(p_dispute uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d record; b record; qpa numeric; ceil numeric; overreach numeric; gap_pct numeric; pct numeric;
        pm text; pv numeric; om text; ov numeric; c_mode text; c_val numeric; c_src text; basis text; meth text; above boolean;
begin
  select * into d from public.disputes where id=p_dispute;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if public.auth_org_id() is not null and d.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;
  select * into b from public.benchmarks where cpt = d.cpt_code;
  if not found then return jsonb_build_object('ok',false,'reason','no_benchmark','cpt',d.cpt_code); end if;

  qpa := coalesce(d.qpa_amount, round(b.medicare * 1.5, 2));

  -- Resolve ceiling policy: case override > plan policy > org default > global default.
  if d.ceiling_override is not null then
    ceil := round(d.ceiling_override, 2); c_src := 'manual_override'; meth := 'manual_ceiling'; basis := 'manual override for this case';
  else
    select ceiling_mode, ceiling_value into pm, pv from public.plans where id = d.plan_id;
    select ceiling_mode, ceiling_value into om, ov from public.orgs  where id = d.org_id;
    if pm is not null and pv is not null then c_mode := pm; c_val := pv; c_src := 'plan_policy';
    elsif om is not null and ov is not null then c_mode := om; c_val := ov; c_src := 'org_default';
    else
      select (value#>>'{}')::numeric into pct from public.regulatory_config where key='defensible_ceiling_pct_of_qpa';
      c_mode := 'pct_of_qpa'; c_val := coalesce(pct, 125); c_src := 'global_default';
    end if;
    if c_mode = 'amount' then
      ceil := round(c_val, 2); meth := 'flat_amount'; basis := 'plan-authorized flat ceiling of '||to_char(c_val,'FM$999,999,990');
    else
      ceil := round(qpa * c_val/100.0, 2); meth := 'pct_of_qpa_'||c_val::text; basis := c_val::text||'% of QPA';
    end if;
    -- The built-in default stays conservative: never above the regional benchmark.
    -- Explicit plan/org policy (and per-case overrides) may exceed it, flagged below.
    if c_src = 'global_default' then ceil := least(ceil, round(b.regional_median, 2)); end if;
  end if;

  above := (b.regional_median is not null and ceil > round(b.regional_median, 2));

  overreach := round(coalesce(d.demand_amount, b.regional_median) - qpa, 2);
  gap_pct   := case when qpa > 0 then round((coalesce(d.demand_amount, b.regional_median) - qpa) / qpa * 100, 0) else null end;

  if d.qpa_amount is null then update public.disputes set qpa_amount = qpa where id = p_dispute; end if;

  delete from public.qpa_records where dispute_id = p_dispute;
  insert into public.qpa_records (org_id, dispute_id, plan_qpa, methodology, benchmark_regional, benchmark_medicare_mult, contracted_median, defensible_ceiling, indexing_current, notes, ceiling_source, ceiling_above_benchmark)
  values (d.org_id, p_dispute, qpa, meth, b.regional_median, round(b.medicare*3,2), qpa, ceil, true,
          'Ceiling = '||basis||' ('||replace(c_src,'_',' ')||')'||
          case when above then '. Exceeds the regional benchmark of '||to_char(b.regional_median,'FM$999,999,990')||' — flagged as above the defensible benchmark.'
               else ', within the regional benchmark.' end||
          ' Demand exceeds QPA by '||coalesce(gap_pct,0)||'%.',
          c_src, above);

  return jsonb_build_object('ok',true,'plan_qpa',qpa,'medicare',b.medicare,'regional_median',b.regional_median,
    'defensible_ceiling',ceil,'ceiling_basis',basis,'ceiling_source',c_src,'ceiling_above_benchmark',above,
    'initiator_overreach',overreach,'demand_vs_qpa_pct',gap_pct);
end $function$;

-- 3) Policy setters (org-checked, SECURITY DEFINER) that recompute active cases -
CREATE OR REPLACE FUNCTION public.set_plan_ceiling(p_plan uuid, p_mode text, p_value numeric)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g uuid := public.auth_org_id(); n int := 0; r record;
begin
  perform 1 from public.plans where id = p_plan and (g is null or org_id = g);
  if not found then raise exception 'plan not found or not authorized'; end if;
  if p_mode is not null and p_mode not in ('pct_of_qpa','amount') then raise exception 'invalid ceiling mode'; end if;
  if p_mode is not null and (p_value is null or p_value <= 0) then raise exception 'ceiling value must be positive'; end if;
  update public.plans
     set ceiling_mode = p_mode,
         ceiling_value = case when p_mode is null then null else p_value end,
         ceiling_updated_at = now(),
         ceiling_updated_by = coalesce(auth.jwt()->>'email', current_user)
   where id = p_plan;
  for r in select id from public.disputes where plan_id = p_plan and coalesce(workflow_state,'') <> 'closed' loop
    perform public.compute_qpa_defense(r.id); n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'recomputed', n);
end $function$;

CREATE OR REPLACE FUNCTION public.set_org_ceiling(p_mode text, p_value numeric)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g uuid := public.auth_org_id(); n int := 0; r record;
begin
  if g is null then raise exception 'no org context'; end if;
  if p_mode is not null and p_mode not in ('pct_of_qpa','amount') then raise exception 'invalid ceiling mode'; end if;
  if p_mode is not null and (p_value is null or p_value <= 0) then raise exception 'ceiling value must be positive'; end if;
  update public.orgs set ceiling_mode = p_mode, ceiling_value = case when p_mode is null then null else p_value end where id = g;
  -- recompute active cases whose plan has no plan-level policy (they inherit the org default)
  for r in select d.id from public.disputes d
             left join public.plans pl on pl.id = d.plan_id
            where d.org_id = g and coalesce(d.workflow_state,'') <> 'closed' and pl.ceiling_mode is null loop
    perform public.compute_qpa_defense(r.id); n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'recomputed', n);
end $function$;

CREATE OR REPLACE FUNCTION public.list_plan_ceilings()
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$
  select jsonb_build_object(
    'org', (select jsonb_build_object('ceiling_mode', ceiling_mode, 'ceiling_value', ceiling_value)
              from public.orgs where id = public.auth_org_id()),
    'global_pct', coalesce((select (value#>>'{}')::numeric from public.regulatory_config where key='defensible_ceiling_pct_of_qpa'), 125),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'plan_type', p.plan_type, 'employer', e.name,
        'ceiling_mode', p.ceiling_mode, 'ceiling_value', p.ceiling_value,
        'ceiling_updated_at', p.ceiling_updated_at, 'ceiling_updated_by', p.ceiling_updated_by,
        'active_cases', (select count(*) from public.disputes d where d.plan_id = p.id and coalesce(d.workflow_state,'') <> 'closed')
      ) order by e.name nulls last, p.name)
      from public.plans p left join public.employers e on e.id = p.employer_id
      where public.auth_org_id() is null or p.org_id = public.auth_org_id()), '[]'::jsonb)
  );
$function$;
