import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabasePublicEnv } from "../env";

let client: SupabaseClient | null = null;

/** Cliente del navegador con la sesión del usuario (solo lectura por RLS y Realtime). */
export function getBrowserClient(): SupabaseClient {
  if (!client) {
    const { url, key } = supabasePublicEnv();
    // También aquí: el cliente del navegador reescribe las cookies de sesión al refrescar el token.
    client = createBrowserClient(url, key, { cookieOptions: { secure: process.env.NODE_ENV === "production" } });
  }
  return client;
}
