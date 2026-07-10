-- Tighten/correct citations against verified eCFR subsections (2026-07).
update public.template_clauses c set body = replace(body,
  '45 CFR §149.110(c) and §149.120(c)(2)', '45 CFR §149.110(b)(3)(iii) and §149.120(c)(2)')
from public.document_templates t
where c.template_id=t.id and t.org_id is null and t.code='cost_share_correction' and c.key='intro';

update public.template_clauses c set body = replace(body,
  'at 45 CFR §149.140.', 'at 45 CFR §149.140(d)(1).')
from public.document_templates t
where c.template_id=t.id and t.org_id is null and t.code='qpa_disclosure' and c.key='intro';
update public.template_clauses c set body = replace(body,
  'the rationale for the modification, as required.', 'the rationale for the modification, as required by 45 CFR §149.140(d)(1)(ii).')
from public.document_templates t
where c.template_id=t.id and t.org_id is null and t.code='qpa_disclosure' and c.key='downcoding';

update public.template_clauses c set body = replace(body,
  'consistent with the certified IDR entity conflict-of-interest requirements under 45 CFR §149.510.',
  'consistent with the certified IDR entity conflict-of-interest standard at 45 CFR §149.510(a)(2)(iv) and the selection and objection process at §149.510(c)(1)(ii).')
from public.document_templates t
where c.template_id=t.id and t.org_id is null and t.code='idre_conflict_objection' and c.key='intro';

update public.template_clauses c set body = replace(body,
  'for the above item, within the payment window required by the No Surprises Act.',
  'for the above item, not later than 30 calendar days after the determination, as required by 45 CFR §149.510(c)(4)(ix).')
from public.document_templates t
where c.template_id=t.id and t.org_id is null and t.code='award_remittance' and c.key='intro';
