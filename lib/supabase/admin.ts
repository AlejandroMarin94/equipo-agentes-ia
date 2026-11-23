import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabasePublicEnv } from "../env";

/** Cliente con la service role key: se salta RLS. Solo en el servidor, nunca en el navegador. */
export function createAdminClient() {
  const { url } = supabasePublicEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
