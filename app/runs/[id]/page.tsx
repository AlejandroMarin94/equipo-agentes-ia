import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/app/components/AppHeader";
import { getUser } from "@/lib/supabase/server";
import type { Run, RunEvent, RunFile, Task } from "@/lib/types";
import { RunView } from "./RunView";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const { supabase, user } = await getUser();
  if (!user) redirect("/login");

  // Con la sesión del usuario: RLS garantiza que solo ve sus ejecuciones.
  const { data: run } = await supabase.from("runs").select("*").eq("id", id).maybeSingle();
  if (!run) notFound();

  const [tasks, events, files] = await Promise.all([
    supabase.from("tasks").select("*").eq("run_id", id).order("position"),
    supabase.from("events").select("*").eq("run_id", id).order("id"),
    supabase.from("run_files").select("*").eq("run_id", id).order("path"),
  ]);

  return (
    <>
      <AppHeader email={user.email} />
      <RunView
        initialRun={run as Run}
        initialTasks={(tasks.data ?? []) as Task[]}
        initialEvents={(events.data ?? []) as RunEvent[]}
        initialFiles={(files.data ?? []) as RunFile[]}
      />
    </>
  );
}
