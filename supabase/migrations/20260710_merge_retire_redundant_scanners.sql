-- Merge step 1: retire the redundant scanner layer (superseded by review_cases / ncci_edits / mue_values).
-- Applied live to Supabase ssjougrsaecdwfuxeasd on 2026-07-10.
-- Runs AFTER the create migrations; keeps the determination templates + CMS_* authorities + all state/QPA/air/RBP work.
DROP FUNCTION IF EXISTS public.prescreen_payment_integrity(jsonb);
DROP FUNCTION IF EXISTS public.run_payment_integrity(uuid, jsonb);
DROP FUNCTION IF EXISTS public.get_payment_integrity(uuid);
DROP FUNCTION IF EXISTS public.list_payment_integrity_rules();
DROP FUNCTION IF EXISTS public.prescreen_bill_review(jsonb);
DROP FUNCTION IF EXISTS public.list_bill_review_rules(text);
DROP TABLE IF EXISTS public.payment_integrity_findings CASCADE;
DROP TABLE IF EXISTS public.payment_integrity_rules CASCADE;
DROP TABLE IF EXISTS public.bill_review_rules CASCADE;
ALTER TABLE public.disputes DROP COLUMN IF EXISTS pi_score;
