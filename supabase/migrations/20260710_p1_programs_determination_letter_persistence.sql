-- P1 programs depth: persist generated determination letters for review cases.
-- render_review_determination() is a pure renderer (returns {title, html}); nothing was saved, so a
-- generated letter couldn't be retrieved, versioned, audited, or e-signed. review cases aren't disputes,
-- and public.documents requires a NOT NULL dispute_id, so persisted review letters get their own table.
-- Verified on demo: save_review_determination(<review_case>) → persists + returns document_id + sha256;
-- list_review_documents(<review_case>) returns the saved version. UI: app/programs/page.js CaseDetail
-- gains a "Generate & save" button, a saved-versions list (status + sha256 + date + View), and an
-- iframe preview with .html download.

CREATE TABLE IF NOT EXISTS public.review_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.orgs(id),
  review_case_id uuid NOT NULL REFERENCES public.review_cases(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'determination_letter',
  title          text NOT NULL,
  content        text,                       -- rendered HTML body
  template_code  text,
  sha256         text,                       -- content-integrity hash of the rendered body
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  esign_status   text NOT NULL DEFAULT 'unsigned',
  signed_by      text,
  signed_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_documents_case_idx ON public.review_documents(review_case_id, created_at DESC);

ALTER TABLE public.review_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_documents_read ON public.review_documents;
CREATE POLICY review_documents_read ON public.review_documents FOR SELECT
  USING (public.auth_org_id() is null or org_id = public.auth_org_id());
DROP POLICY IF EXISTS review_documents_write ON public.review_documents;
CREATE POLICY review_documents_write ON public.review_documents FOR ALL
  USING (org_id = public.auth_org_id()) WITH CHECK (org_id = public.auth_org_id());

-- Render + persist. Each call stores a new version (created_at + sha256), so edits/regenerations are
-- preserved as an auditable history. Returns the new document id, content hash, and the rendered html.
CREATE OR REPLACE FUNCTION public.save_review_determination(p_case uuid, p_answers jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rc record; r jsonb; v_html text; v_title text; v_tcode text; v_sha text; v_id uuid;
begin
  select org_id, review_type into rc from public.review_cases where id = p_case;
  if not found then return jsonb_build_object('ok',false,'reason','review_case_not_found'); end if;
  if public.auth_org_id() is not null and rc.org_id <> public.auth_org_id() then raise exception 'not authorized'; end if;

  r := public.render_review_determination(p_case, coalesce(p_answers,'{}'::jsonb));
  if not coalesce((r->>'ok')::boolean, false) then return r; end if;

  v_html  := r->>'html';
  v_title := r->>'title';
  v_tcode := r->>'template';
  v_sha   := encode(extensions.digest(coalesce(v_html,''),'sha256'),'hex');

  insert into public.review_documents(org_id, review_case_id, kind, title, content, template_code, sha256, answers)
  values (rc.org_id, p_case, 'determination_letter', v_title, v_html, v_tcode, v_sha, coalesce(p_answers,'{}'::jsonb))
  returning id into v_id;

  return jsonb_build_object('ok',true,'document_id',v_id,'title',v_title,'template',v_tcode,
                            'sha256',v_sha,'review_type',r->>'review_type','html',v_html,'persisted',true);
end $function$;

-- Convenience list for the programs case-detail panel (metadata only; fetch content by id when needed).
CREATE OR REPLACE FUNCTION public.list_review_documents(p_case uuid)
 RETURNS TABLE(id uuid, kind text, title text, template_code text, sha256 text,
               esign_status text, signed_by text, signed_at timestamptz, created_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id, kind, title, template_code, sha256, esign_status, signed_by, signed_at, created_at
  from public.review_documents
  where review_case_id = p_case
    and (public.auth_org_id() is null or org_id = public.auth_org_id())
  order by created_at desc;
$function$;
