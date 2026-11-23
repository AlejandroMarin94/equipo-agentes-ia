/**
 * Crea (o actualiza la contraseña de) el usuario de prueba en Supabase Auth.
 *
 *   npm run create-test-user -- <email> <contraseña>
 *   TEST_USER_EMAIL=... TEST_USER_PASSWORD=... npm run create-test-user   # sin dejar la contraseña en los argumentos
 *
 * Lee NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY del entorno o de .env.local.
 */
import { createClient } from "@supabase/supabase-js";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

async function main() {
  const email = process.argv[2] ?? process.env.TEST_USER_EMAIL;
  const password = process.argv[3] ?? process.env.TEST_USER_PASSWORD;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!email || !password) {
    throw new Error("Uso: npm run create-test-user -- <email> <contraseña> (o TEST_USER_EMAIL y TEST_USER_PASSWORD en el entorno)");
  }
  if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
  if (!url || !serviceKey) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!error) {
    console.log(`Usuario creado: ${data.user.email}`);
    return;
  }

  // Si ya existe, se actualiza la contraseña para poder repetir el script.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;
  const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) throw error;
  const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
  if (updateError) throw updateError;
  console.log(`El usuario ya existía; contraseña actualizada: ${email}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
