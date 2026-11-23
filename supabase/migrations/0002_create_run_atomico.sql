-- Creación de ejecuciones con los límites comprobados de forma atómica.
-- Se puede pegar tal cual en el SQL Editor de Supabase (después de 0001_init.sql).
--
-- Antes el servidor contaba y luego insertaba: varias peticiones a la vez podían pasar todas el límite.
-- Ahora contar e insertar ocurren en la misma transacción, serializada con un advisory lock.
--
-- Errores (los traduce lib/supabase/repository.ts):
--   message = 'run_limit_day'   → el usuario ha llegado a p_max_per_day ejecuciones en 24 h.
--   message = 'run_limit_hour'  → se ha llegado a p_max_per_hour ejecuciones en la última hora entre todos;
--                                 detail = instante (epoch en ms) en que queda libre el siguiente hueco.

create or replace function public.create_run(
  p_user_id uuid,
  p_request text,
  p_max_per_hour integer,
  p_max_per_day integer
)
returns public.runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release timestamptz;
  v_run public.runs;
begin
  -- Una sola creación a la vez en toda la base de datos: el límite por hora es global.
  perform pg_advisory_xact_lock(hashtext('public.create_run'));

  if (
    select count(*) from public.runs
    where user_id = p_user_id and created_at >= now() - interval '24 hours'
  ) >= p_max_per_day then
    raise exception using errcode = 'P0001', message = 'run_limit_day';
  end if;

  -- Si ya hay p_max_per_hour en la última hora, el hueco se libera cuando la p_max_per_hour-ésima
  -- más reciente cumpla una hora.
  select created_at + interval '1 hour' into v_release
  from public.runs
  where created_at >= now() - interval '1 hour'
  order by created_at desc
  offset greatest(p_max_per_hour - 1, 0)
  limit 1;
  if v_release is not null then
    raise exception using
      errcode = 'P0001',
      message = 'run_limit_hour',
      detail = (floor(extract(epoch from v_release) * 1000))::bigint::text;
  end if;

  insert into public.runs (user_id, request)
  values (p_user_id, p_request)
  returning * into v_run;
  return v_run;
end;
$$;

-- Solo el servidor (service_role) puede llamarla.
revoke all on function public.create_run(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.create_run(uuid, text, integer, integer) to service_role;
