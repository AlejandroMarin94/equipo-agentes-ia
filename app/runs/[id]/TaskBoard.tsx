import { LIMITS } from "@/lib/limits";
import { TASK_COLUMNS } from "@/lib/ui";
import type { Task } from "@/lib/types";

function TaskCard({ task }: { task: Task }) {
  const showFeedback =
    task.last_feedback && (task.status === "failed" || task.status === "blocked" || task.status === "developing");
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <h4 className="font-medium text-slate-900">
        <span className="text-slate-400">#{task.position + 1}</span> {task.title}
      </h4>
      {task.description && <p className="mt-1 line-clamp-3 text-xs text-slate-600">{task.description}</p>}
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer select-none text-slate-500">
          {task.acceptance_criteria.length}{" "}
          {task.acceptance_criteria.length === 1 ? "criterio de aceptación" : "criterios de aceptación"}
        </summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {task.acceptance_criteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </details>
      <p className="mt-2 text-xs text-slate-500">
        Fallos de Testing: {task.attempts}/{LIMITS.maxAttempts}
      </p>
      {showFeedback && (
        <div className="mt-2 rounded-md bg-red-50 p-2 text-xs whitespace-pre-line text-red-800">
          <p className="font-medium">Último feedback de Testing:</p>
          {task.last_feedback}
        </div>
      )}
    </article>
  );
}

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return <p className="text-sm text-slate-500">El Orquestador todavía no ha repartido las tareas.</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {TASK_COLUMNS.map((column) => {
        const items = tasks.filter((t) => t.status === column.status);
        return (
          <section key={column.status} className={`rounded-xl border-t-4 bg-slate-100 p-2 ${column.className}`}>
            <h3 className="mb-2 flex items-center justify-between px-1 text-sm font-medium text-slate-700">
              {column.label}
              <span className="rounded-full bg-white px-2 text-xs text-slate-500">{items.length}</span>
            </h3>
            <div className="space-y-2">
              {items.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
