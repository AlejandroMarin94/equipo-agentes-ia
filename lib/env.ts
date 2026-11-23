/** Variables públicas de Supabase. Next las incrusta en el cliente al compilar. */
export function supabasePublicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY (revisa .env.local)");
  }
  return { url, key };
}

const positive = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Ejecuciones de todos los usuarios juntos en la última hora (protege la suscripción de Claude). */
export const maxRunsPerHour = (env: Record<string, string | undefined> = process.env) => positive(env.MAX_RUNS_PER_HOUR, 3);

/** Ejecuciones de cada usuario en 24 horas. */
export const maxRunsPerDay = (env: Record<string, string | undefined> = process.env) => positive(env.MAX_RUNS_PER_DAY, 10);
