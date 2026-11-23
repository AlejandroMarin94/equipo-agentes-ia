-- Equipo de agentes IA: esquema inicial.
-- Se puede pegar tal cual en el SQL Editor de Supabase.
--
-- Lecturas: cada usuario solo ve sus propias ejecuciones (RLS).
-- Escrituras: solo el servidor, con la service role key (que se salta RLS).

-- Ejecuciones -----------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request text not null check (char_length(request) between 5 and 500),
  status text not null default 'planning'
    check (status in ('planning', 'developing', 'testing', 'summarizing', 'done', 'failed')),
  summary text,
  error_count integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create index runs_user_created_idx on public.runs (user_id, created_at desc);

-- Tareas ----------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  position integer not null,
  title text not null,
  description text not null default '',
  acceptance_criteria jsonb not null default '[]'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'developing', 'testing', 'failed', 'done', 'blocked')),
  attempts integer not null default 0,
  last_feedback text,
  updated_at timestamptz not null default now(),
  unique (run_id, position)
);

-- Archivos de la web de cada ejecución ----------------------------------------
create table public.run_files (
  run_id uuid not null references public.runs (id) on delete cascade,
  path text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  primary key (run_id, path)
);

-- Registro de eventos de los agentes ------------------------------------------
create table public.events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  agent text not null check (agent in ('orchestrator', 'develop', 'testing', 'system')),
  kind text not null,
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index events_run_idx on public.events (run_id, id);

-- Seguridad a nivel de fila ---------------------------------------------------
alter table public.runs enable row level security;
alter table public.tasks enable row level security;
alter table public.run_files enable row level security;
alter table public.events enable row level security;

create policy "Cada usuario lee sus ejecuciones" on public.runs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Cada usuario lee las tareas de sus ejecuciones" on public.tasks
  for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and r.user_id = (select auth.uid())));

create policy "Cada usuario lee los archivos de sus ejecuciones" on public.run_files
  for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and r.user_id = (select auth.uid())));

create policy "Cada usuario lee los eventos de sus ejecuciones" on public.events
  for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and r.user_id = (select auth.uid())));

-- Permisos explícitos (los usuarios solo leen; el servidor escribe con service_role).
revoke all on public.runs, public.tasks, public.run_files, public.events from anon, authenticated;
grant select on public.runs, public.tasks, public.run_files, public.events to authenticated;
grant all on public.runs, public.tasks, public.run_files, public.events to service_role;
grant usage, select on sequence public.events_id_seq to service_role;

-- Tiempo real: la página de cada ejecución se suscribe a estos cambios.
alter publication supabase_realtime add table public.runs, public.tasks, public.events;
