import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublicEnv } from "../env";

/** Cliente con la sesión del usuario (respeta RLS). Para Server Components, acciones y rutas. */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = supabasePublicEnv();
  return createServerClient(url, key, {
    cookieOptions: { secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // En Server Components no se pueden escribir cookies; el proxy ya refresca la sesión.
        }
      },
    },
  });
}

/** Usuario autenticado (validado contra Supabase Auth) o null. */
export async function getUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}
