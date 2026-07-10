-- Avertyn — Seed: global "Eligibility challenge letter" template
-- A template = clauses (conditionally included) + a questionnaire. This one drives
-- inclusion off the dispute's failed eligibility findings and a few operator answers.
-- Re-runnable: replaces the global challenge_letter template in place.

delete from public.document_templates where code = 'challenge_letter' and org_id is null;

with t as (
  insert into public.document_templates (org_id, code, kind, title, description, jurisdiction)
  values (null, 'challenge_letter', 'challenge_letter',
    'Eligibility challenge — {{dispute.external_ref}}',
    'Objects to a Federal IDR dispute''s eligibility, auto-citing each failed eligibility finding. Auto-fills from the case; a few questions tune the tone and optional arguments.',
    'federal')
  returning id
)
insert into public.template_questions (template_id, seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt)
select t.id, v.seq, v.key, v.prompt, v.help, v.input_type, v.options, v.default_val, v.required, v.ai_assist, v.ai_prompt
from t, (values
  (10, 'signer_name', 'Signer name', 'The person who will sign and submit this objection.', 'text', null::jsonb, null::jsonb, true, false, null::text),
  (20, 'signer_title', 'Signer title', 'Appears under the signature.', 'text', null::jsonb, '"Authorized Plan Representative"'::jsonb, false, false, null),
  (30, 'tone', 'Tone of the closing', 'Sets the closing paragraph.', 'select',
      '[{"value":"firm","label":"Firm — expects dismissal"},{"value":"standard","label":"Standard — cooperative"},{"value":"measured","label":"Measured — open to discussion"}]'::jsonb,
      '"standard"'::jsonb, false, false, null),
  (40, 'include_qpa_note', 'Include alternative QPA note', 'Adds an in-the-alternative paragraph defending the plan''s QPA against the demand.', 'boolean', null, 'true'::jsonb, false, false, null),
  (50, 'request_closure', 'Request formal closure', 'Adds an explicit request that the IDRE close the dispute as ineligible.', 'boolean', null, 'true'::jsonb, false, false, null),
  (60, 'cc_initiator', 'CC the initiating party', 'Adds a cc line to the initiator.', 'boolean', null, 'false'::jsonb, false, false, null),
  (70, 'extra_argument', 'Additional argument (optional)', 'Free-text paragraph inserted before the QPA note. Use the AI draft button to generate from the case facts.', 'textarea', null, '""'::jsonb, false, true,
      'Write one concise, professional paragraph of additional eligibility argument for a No Surprises Act IDR eligibility objection, grounded only in the supplied dispute facts and failed eligibility findings. Do not invent facts. Neutral legal tone.')
) as v(seq, key, prompt, help, input_type, options, default_val, required, ai_assist, ai_prompt);

with t as (select id from public.document_templates where code='challenge_letter' and org_id is null)
insert into public.template_clauses (template_id, seq, key, body, include_when, repeat_over)
select t.id, v.seq, v.key, v.body, v.include_when, v.repeat_over
from t, (values
  (10, 'letterhead',
    '<p class="doc-meta">{{date.today}}</p><p><strong>Re: Eligibility objection — Federal IDR Dispute {{dispute.external_ref}}</strong><br/>CPT {{dispute.cpt_code}} &middot; Date of service {{date.service}} &middot; Plan: {{plan.name}}</p>',
    null::jsonb, null::text),
  (20, 'salutation',
    '<p>To the Certified IDR Entity and {{initiator.name}}:</p>',
    null, null),
  (30, 'intro',
    '<p>On behalf of {{dispute.plan_legal_name}} (the &ldquo;Plan&rdquo;), we respectfully object to the eligibility of the above-referenced dispute for the Federal Independent Dispute Resolution (IDR) process. For the reasons set out below, this dispute does not satisfy the threshold requirements of the No Surprises Act and its implementing regulations, and should be dismissed as ineligible.</p>',
    null, null),
  (40, 'grounds_intro',
    '<p>The Plan&rsquo;s objection rests on the following independent ground(s):</p>',
    '{"flag":"has_findings"}'::jsonb, null),
  (50, 'ground_item',
    '<li><strong>{{this.name}}.</strong> {{this.detail}}</li>',
    '{"flag":"has_findings"}'::jsonb, 'findings'),
  (55, 'no_findings',
    '<p>The Plan is reviewing this dispute for eligibility defects and reserves all rights to supplement this objection. Counsel should confirm the specific grounds before filing.</p>',
    '{"not":{"flag":"has_findings"}}'::jsonb, null),
  (60, 'extra_argument',
    '<p>{{answers.extra_argument}}</p>',
    '{"answer":"extra_argument"}'::jsonb, null),
  (70, 'qpa_note',
    '<p>Without waiver of the foregoing eligibility objection, and solely in the alternative, the Plan notes that its Qualifying Payment Amount of {{money.qpa}} &mdash; corroborated by a FAIR Health regional reference of {{money.fairhealth}} &mdash; represents the appropriate out-of-network rate for this item. The initiating party&rsquo;s demand of {{money.demand}} is not supported by the statutory factors.</p>',
    '{"answer":"include_qpa_note","equals":true}'::jsonb, null),
  (75, 'closure',
    '<p>Accordingly, the Plan requests that the Certified IDR Entity close this dispute as ineligible for the Federal IDR process.</p>',
    '{"answer":"request_closure","equals":true}'::jsonb, null),
  (80, 'tone_firm',
    '<p>The eligibility defects identified above are dispositive. The Plan expects prompt dismissal and reserves all available remedies for improperly initiated disputes.</p>',
    '{"answer":"tone","equals":"firm"}'::jsonb, null),
  (82, 'tone_standard',
    '<p>The Plan appreciates the Certified IDR Entity&rsquo;s attention to these threshold matters and is available to provide any supporting documentation required.</p>',
    '{"answer":"tone","equals":"standard"}'::jsonb, null),
  (84, 'tone_measured',
    '<p>The Plan raises these points to resolve the dispute efficiently and remains open to good-faith discussion consistent with the No Surprises Act.</p>',
    '{"answer":"tone","equals":"measured"}'::jsonb, null),
  (90, 'signature',
    '<p class="sig">Respectfully submitted,</p><p class="sig"><strong>{{answers.signer_name}}</strong><br/>{{answers.signer_title}}<br/>For {{dispute.plan_legal_name}}<br/>{{org.name}}</p>',
    null, null),
  (95, 'cc',
    '<p class="doc-meta">cc: {{initiator.name}}</p>',
    '{"answer":"cc_initiator","equals":true}'::jsonb, null)
) as v(seq, key, body, include_when, repeat_over);
