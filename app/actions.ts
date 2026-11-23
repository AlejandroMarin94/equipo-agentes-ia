"use server";

import { redirect } from "next/navigation";
import { startRun } from "@/lib/engine/engine";
import { maxRunsPerDay } from "@/lib/env";
import { SupabaseRepository } from "@/lib/supabase/repository";
import { createClient, getUser } from "@/lib/supabase/server";

export interface FormState {
  error: string | null;
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Introduce email y contraseña." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Email o contraseña incorrectos." };
  redirect("/");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function createRun(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user } = await getUser();
  if (!user) redirect("/login");

  const result = await startRun(new SupabaseRepository(), user.id, String(formData.get("request") ?? ""), {
    maxRunsPerDay: maxRunsPerDay(),
  });
  if (!result.ok) return { error: result.error };
  redirect(`/runs/${result.runId}`);
}
