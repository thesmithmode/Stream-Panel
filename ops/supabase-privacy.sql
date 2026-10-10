-- Old cloud exports are server-only. Preserve every row and service_role grants.
BEGIN;
ALTER TABLE public.sp_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_presence_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sp_presence_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sp_persons, public.sp_identities, public.sp_events, public.sp_presence_polls, public.sp_presence_members FROM anon, authenticated;
COMMIT;
