import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Cliente del navegador con la sesión del usuario (solo lectura por RLS y Realtime). */
export function getBrowserClient(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Faltan las variables públicas de Supabase");
    client = createBrowserClient(url, key);
  }
  return client;
}
