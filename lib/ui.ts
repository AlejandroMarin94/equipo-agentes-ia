import type { Agent, RunStatus, TaskStatus } from "./types";

export const RUN_STATUS: Record<RunStatus, { label: string; className: string }> = {
  planning: { label: "Planificando", className: "bg-violet-100 text-violet-800" },
  developing: { label: "Desarrollando", className: "bg-sky-100 text-sky-800" },
  testing: { label: "Probando", className: "bg-amber-100 text-amber-800" },
  summarizing: { label: "Resumiendo", className: "bg-violet-100 text-violet-800" },
  done: { label: "Terminada", className: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Terminada con fallos", className: "bg-red-100 text-red-800" },
};

export const TASK_COLUMNS: { status: TaskStatus; label: string; className: string }[] = [
  { status: "pending", label: "Pendiente", className: "border-slate-300" },
  { status: "developing", label: "En desarrollo", className: "border-sky-400" },
  { status: "testing", label: "En pruebas", className: "border-amber-400" },
  { status: "failed", label: "Con fallos", className: "border-orange-400" },
  { status: "done", label: "Hecha", className: "border-emerald-500" },
  { status: "blocked", label: "Bloqueada", className: "border-red-500" },
];

export const AGENTS: Record<Agent, { name: string; role: string; badge: string }> = {
  orchestrator: {
    name: "Orquestador",
    role: "Divide la petición en tareas, las reparte y resume el resultado.",
    badge: "bg-violet-100 text-violet-800",
  },
  develop: {
    name: "Develop",
    role: "Escribe y modifica los archivos de la web.",
    badge: "bg-sky-100 text-sky-800",
  },
  testing: {
    name: "Testing",
    role: "Comprueba cada tarea y devuelve lo que falla.",
    badge: "bg-amber-100 text-amber-800",
  },
  system: { name: "Sistema", role: "", badge: "bg-slate-100 text-slate-700" },
};

const timeFormat = new Intl.DateTimeFormat("es-ES", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Madrid",
});

const dateFormat = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Madrid",
});

export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
