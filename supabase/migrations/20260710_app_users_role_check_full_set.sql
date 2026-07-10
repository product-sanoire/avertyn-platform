-- Align the app_users.role check with the roles defined in role_perms
-- (manager & auditor are real roles used by can_action()), so the Admin UI
-- role picker never produces a constraint violation.
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role = any (array['admin','manager','analyst','auditor','viewer']));
