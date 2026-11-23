import { AGENTS, formatTime } from "@/lib/ui";
import type { RunEvent, Task } from "@/lib/types";

const KIND_STYLE: Partial<Record<RunEvent["kind"], string>> = {
  test_pass: "text-emerald-700",
  test_fail: "text-orange-700",
  error: "text-red-700",
  rate_limit: "text-amber-700",
  thinking: "text-slate-500 italic",
};

/** Modelo que respondió (payload.model) y, si hubo respaldo, los que fallaron antes. */
function modelOf(event: RunEvent): { model: string; fallbackFrom: string[] } | null {
  const payload = event.payload as { model?: unknown; fallbackFrom?: unknown } | null;
  if (!payload || typeof payload.model !== "string") return null;
  const fallbackFrom = Array.isArray(payload.fallbackFrom) ? payload.fallbackFrom.map(String) : [];
  return { model: payload.model, fallbackFrom };
}

export function EventLog({ events, tasks }: { events: RunEvent[]; tasks: Task[] }) {
  const taskNumber = new Map(tasks.map((t) => [t.id, t.position + 1]));
  const ordered = [...events].reverse();
  return (
    <ol className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
      {ordered.map((event) => (
        <li key={event.id} className="flex gap-2 text-sm">
          <span className="w-16 shrink-0 pt-0.5 text-xs text-slate-400 tabular-nums">
            {formatTime(event.created_at)}
          </span>
          <div className="min-w-0">
            <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs font-medium ${AGENTS[event.agent].badge}`}>
              {AGENTS[event.agent].name}
            </span>
            {event.task_id && taskNumber.has(event.task_id) && (
              <span className="mr-1.5 text-xs text-slate-400">tarea #{taskNumber.get(event.task_id)}</span>
            )}
            <span className={`break-words ${KIND_STYLE[event.kind] ?? "text-slate-800"}`}>{event.message}</span>
            <ModelTag event={event} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function ModelTag({ event }: { event: RunEvent }) {
  const info = modelOf(event);
  if (!info) return null;
  const fallback = info.fallbackFrom.length > 0;
  return (
    <span
      className={`ml-1.5 whitespace-nowrap text-xs ${fallback ? "text-amber-700" : "text-slate-400"}`}
      title={fallback ? `Respaldo: antes fallaron ${info.fallbackFrom.join(", ")}` : undefined}
    >
      · {info.model}
      {fallback && " (respaldo)"}
    </span>
  );
}
