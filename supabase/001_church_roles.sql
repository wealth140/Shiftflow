-- Onixora church hierarchy and row-level security.
-- Run after the original organizations/worker_invite_tokens migration.

do $$
begin
  create type public.church_role as enum ('pastor', 'coordinator', 'ministry_leader');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.ministries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists public.organization_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.church_role not null,
  ministry_id uuid references public.ministries(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  check (
    (role = 'ministry_leader' and ministry_id is not null)
    or (role <> 'ministry_leader')
  )
);

create table if not exists public.worker_ministry_memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  worker_id bigint not null,
  ministry_id uuid not null references public.ministries(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, worker_id),
  unique (org_id, worker_id, ministry_id)
);

create index if not exists ministries_org_idx on public.ministries(org_id);
create index if not exists organization_members_user_idx on public.organization_members(user_id);
create index if not exists worker_ministry_memberships_ministry_idx on public.worker_ministry_memberships(ministry_id);

-- Keep helper functions small and SECURITY DEFINER so policies do not recurse
-- through organization_members while evaluating access to that same table.
create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members
    where org_id = target_org and user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(target_org uuid, allowed_roles public.church_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members
    where org_id = target_org
      and user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

create or replace function public.is_ministry_leader(target_ministry uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members
    where ministry_id = target_ministry
      and user_id = auth.uid()
      and role = 'ministry_leader'
  );
$$;

-- Remove the original owner-wide policy. Leaving it in place would make the
-- new role policies advisory because the old policy would still grant access.
drop policy if exists organizations_owner_all on public.organizations;
drop policy if exists organizations_staff_read on public.organizations;
create policy organizations_staff_read on public.organizations for select
  using (public.is_org_member(id));
drop policy if exists organizations_staff_update on public.organizations;
create policy organizations_staff_update on public.organizations for update
  using (public.has_org_role(id, array['pastor', 'coordinator']::public.church_role[]))
  with check (public.has_org_role(id, array['pastor', 'coordinator']::public.church_role[]));

alter table public.ministries enable row level security;
alter table public.organization_members enable row level security;
alter table public.worker_ministry_memberships enable row level security;

drop policy if exists ministries_read on public.ministries;
create policy ministries_read on public.ministries for select using (public.is_org_member(org_id));
drop policy if exists ministries_manage on public.ministries;
create policy ministries_manage on public.ministries for all
  using (public.has_org_role(org_id, array['pastor', 'coordinator']::public.church_role[]))
  with check (public.has_org_role(org_id, array['pastor', 'coordinator']::public.church_role[]));

drop policy if exists organization_members_read on public.organization_members;
create policy organization_members_read on public.organization_members for select
  using (public.is_org_member(org_id));
drop policy if exists organization_members_manage on public.organization_members;
create policy organization_members_manage on public.organization_members for all
  using (public.has_org_role(org_id, array['pastor']::public.church_role[]))
  with check (public.has_org_role(org_id, array['pastor']::public.church_role[]));
drop policy if exists organization_members_coordinator_leaders on public.organization_members;
create policy organization_members_coordinator_leaders on public.organization_members for all
  using (
    public.has_org_role(org_id, array['coordinator']::public.church_role[])
    and role = 'ministry_leader'
  )
  with check (
    public.has_org_role(org_id, array['coordinator']::public.church_role[])
    and role = 'ministry_leader'
    and ministry_id is not null
  );

drop policy if exists worker_memberships_read on public.worker_ministry_memberships;
create policy worker_memberships_read on public.worker_ministry_memberships for select
  using (public.is_org_member(org_id));
drop policy if exists worker_memberships_manage on public.worker_ministry_memberships;
create policy worker_memberships_manage on public.worker_ministry_memberships for all
  using (
    public.has_org_role(org_id, array['pastor', 'coordinator']::public.church_role[])
    or public.is_ministry_leader(ministry_id)
  )
  with check (
    public.has_org_role(org_id, array['pastor', 'coordinator']::public.church_role[])
    or public.is_ministry_leader(ministry_id)
  );

-- Existing owner accounts become Pastors. Coordinators and leaders are then
-- assigned by a Coordinator from the app.
insert into public.organization_members (org_id, user_id, role)
select id, owner_id, 'pastor'::public.church_role
from public.organizations
on conflict (org_id, user_id) do nothing;

-- This is deliberately a church-only deployment after this migration.
update public.organizations set data = jsonb_set(coalesce(data, '{}'::jsonb), '{orgType}', '"church"'::jsonb, true);
