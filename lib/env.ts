/** Variables públicas de Supabase. Next las incrusta en el cliente al compilar. */
export function supabasePublicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY (revisa .env.local)");
  }
  return { url, key };
}

export function maxRunsPerDay(): number {
  const value = Number(process.env.MAX_RUNS_PER_DAY);
  return Number.isFinite(value) && value > 0 ? value : 15;
}
