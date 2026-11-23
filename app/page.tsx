import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";
import { formatDate } from "@/lib/ui";
import type { Run } from "@/lib/types";
import { AppHeader } from "./components/AppHeader";
import { StatusBadge } from "./components/StatusBadge";
import { NewRunForm } from "./NewRunForm";

export default async function HomePage() {
  const { supabase, user } = await getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("runs")
    .select("id, request, status, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  const runs = (data ?? []) as Pick<Run, "id" | "request" | "status" | "created_at">[];

  return (
    <>
      <AppHeader email={user.email} />
      <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6">
        <NewRunForm />
        <section>
          <h2 className="mb-3 font-semibold text-slate-900">Ejecuciones</h2>
          {runs.length === 0 ? (
            <p className="text-sm text-slate-500">Todavía no hay ninguna. Lanza la primera petición.</p>
          ) : (
            <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/runs/${run.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-slate-900">{run.request}</p>
                      <p className="text-xs text-slate-500">{formatDate(run.created_at)}</p>
                    </div>
                    <StatusBadge status={run.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
