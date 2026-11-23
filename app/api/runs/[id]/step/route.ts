import { NextResponse } from "next/server";
import { RunNotFoundError, step } from "@/lib/engine/engine";
import { getProvider } from "@/lib/llm";
import { SupabaseRepository } from "@/lib/supabase/repository";
import { getUser } from "@/lib/supabase/server";

// Un paso = como mucho una llamada al LLM; 300 s es el máximo de Vercel Hobby con Fluid Compute.
export const maxDuration = 300;

export async function POST(_request: Request, ctx: RouteContext<"/api/runs/[id]/step">) {
  const { id } = await ctx.params;
  try {
    const { supabase, user } = await getUser();
    if (!user) return NextResponse.json({ error: "Sesión caducada" }, { status: 401 });

    // Con la sesión del usuario (RLS): solo puede avanzar sus propias ejecuciones.
    const { data: run } = await supabase.from("runs").select("id").eq("id", id).maybeSingle();
    if (!run) return NextResponse.json({ error: "Ejecución no encontrada" }, { status: 404 });

    const result = await step(new SupabaseRepository(), getProvider(), id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      return NextResponse.json({ error: "Ejecución no encontrada" }, { status: 404 });
    }
    console.error("Error en el paso", id, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Error inesperado" },
      { status: 500 },
    );
  }
}
