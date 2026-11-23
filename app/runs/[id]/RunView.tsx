"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/app/components/StatusBadge";
import { getBrowserClient } from "@/lib/supabase/browser";
import { TERMINAL_STATUSES, type Run, type RunEvent, type RunFile, type Task } from "@/lib/types";
import { formatDate } from "@/lib/ui";
import { AgentCards } from "./AgentCards";
import { EventLog } from "./EventLog";
import { SitePreview } from "./SitePreview";
import { TaskBoard } from "./TaskBoard";

interface Props {
  initialRun: Run;
  initialTasks: Task[];
  initialEvents: RunEvent[];
  initialFiles: RunFile[];
}

interface StepResponse {
  status?: Run["status"];
  done?: boolean;
  busy?: boolean;
  retryAfter?: number;
  error?: string;
}

const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function upsertById<T extends { id: string | number }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const copy = [...list];
  copy[index] = item;
  return copy;
}

export function RunView({ initialRun, initialTasks, initialEvents, initialFiles }: Props) {
  const runId = initialRun.id;
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [tasks, setTasks] = useState(initialTasks);
  const [events, setEvents] = useState(initialEvents);
  const [files, setFiles] = useState(initialFiles);
  const [realtimeOk, setRealtimeOk] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const finished = TERMINAL_STATUSES.includes(run.status);

  /** Relee todo de la base de datos (tras cada paso y como sondeo si falla Realtime). */
  const refresh = useCallback(async () => {
    const supabase = getBrowserClient();
    const [r, t, e, f] = await Promise.all([
      supabase.from("runs").select("*").eq("id", runId).maybeSingle(),
      supabase.from("tasks").select("*").eq("run_id", runId).order("position"),
      supabase.from("events").select("*").eq("run_id", runId).order("id"),
      supabase.from("run_files").select("*").eq("run_id", runId).order("path"),
    ]);
    if (r.data) setRun(r.data as Run);
    if (t.data) setTasks(t.data as Task[]);
    if (e.data) setEvents(e.data as RunEvent[]);
    if (f.data) setFiles(f.data as RunFile[]);
  }, [runId]);

  // Directo con Supabase Realtime.
  useEffect(() => {
    const supabase = getBrowserClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel = supabase
        .channel(`run-${runId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "runs", filter: `id=eq.${runId}` }, (p) => {
          if (p.new && "id" in p.new) setRun(p.new as Run);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `run_id=eq.${runId}` }, (p) => {
          if (p.new && "id" in p.new) {
            setTasks((list) => upsertById(list, p.new as Task).sort((a, b) => a.position - b.position));
          }
        })
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "events", filter: `run_id=eq.${runId}` },
          (p) => setEvents((list) => upsertById(list, p.new as RunEvent)),
        )
        .subscribe((status) => setRealtimeOk(status === "SUBSCRIBED"));
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [runId]);

  // Sondeo cada 2 s si Realtime no está disponible.
  useEffect(() => {
    if (realtimeOk || finished) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [realtimeOk, finished, refresh]);

  // Bucle que hace avanzar al equipo: un paso por petición mientras el run no termine.
  useEffect(() => {
    if (TERMINAL_STATUSES.includes(initialRun.status)) return;
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        let response: Response;
        try {
          response = await fetch(`/api/runs/${runId}/step`, { method: "POST" });
        } catch {
          setError("Sin conexión con el servidor; reintentando…");
          await sleep(5000);
          continue;
        }
        if (cancelled) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        // 502-504: la plataforma cortó el paso (p. ej. tiempo máximo de Vercel). El motor lo retoma solo.
        if (response.status >= 502 && response.status <= 504) {
          setError("El servidor no ha respondido a tiempo; reintentando…");
          await sleep(5000);
          continue;
        }
        const body = (await response.json().catch(() => ({}))) as StepResponse;
        if (!response.ok) {
          setError(body.error ?? `Error ${response.status} al avanzar la ejecución.`);
          return;
        }
        setError(null);
        await refresh();
        if (body.done || cancelled) return;
        if (body.retryAfter) {
          setWaitUntil(Date.now() + body.retryAfter * 1000);
          await sleep(body.retryAfter * 1000);
          setWaitUntil(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, initialRun.status, refresh, attempt, router]);

  // Reloj para la cuenta atrás de la espera.
  useEffect(() => {
    if (!waitUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [waitUntil]);

  const secondsLeft = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
      <section className="space-y-2">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
          ← Todas las ejecuciones
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-xl font-semibold break-words text-slate-900">{run.request}</h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-xs text-slate-500">
          Creada el {formatDate(run.created_at)} · {done}/{tasks.length} tareas hechas ·{" "}
          {realtimeOk ? "en directo" : "actualizando cada 2 s"}
        </p>
        {secondsLeft > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Esperando {secondsLeft} s antes del siguiente paso…
          </p>
        )}
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            <span>{error}</span>
            <button
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-red-800 hover:bg-red-100"
            >
              Reintentar
            </button>
          </div>
        )}
        {finished && run.summary && (
          <div
            className={`rounded-xl border p-4 text-sm ${
              run.status === "done" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
            }`}
          >
            <p className="mb-1 font-semibold">Resumen del Orquestador</p>
            <p className="whitespace-pre-line">{run.summary}</p>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-semibold text-slate-900">Agentes</h2>
        <AgentCards events={events} finished={finished} />
      </section>

      <section>
        <h2 className="mb-3 font-semibold text-slate-900">Tareas</h2>
        <TaskBoard tasks={tasks} />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="lg:col-span-2">
          <h2 className="mb-3 font-semibold text-slate-900">Registro en directo</h2>
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <EventLog events={events} tasks={tasks} />
          </div>
        </section>
        <section className="min-w-0 lg:col-span-3">
          <h2 className="mb-3 font-semibold text-slate-900">Web resultante</h2>
          <SitePreview runId={runId} files={files} />
        </section>
      </div>
    </main>
  );
}
