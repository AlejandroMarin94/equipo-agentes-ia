import { AGENTS, formatTime } from "@/lib/ui";
import type { Agent, RunEvent } from "@/lib/types";

type AgentState = "idle" | "working" | "waiting";

const STATE_LABEL: Record<AgentState, { label: string; className: string; dot: string }> = {
  idle: { label: "En espera", className: "text-slate-600", dot: "bg-slate-300" },
  working: { label: "Trabajando", className: "text-emerald-700", dot: "bg-emerald-500 animate-pulse" },
  waiting: { label: "Esperando por límite de la API", className: "text-amber-700", dot: "bg-amber-500" },
};

/** El estado de cada agente se deduce de su último evento. */
function agentState(events: RunEvent[], agent: Agent, finished: boolean) {
  const last = events.findLast((e) => e.agent === agent);
  let state: AgentState = "idle";
  if (!finished && last?.kind === "thinking") state = "working";
  if (!finished && last?.kind === "rate_limit") state = "waiting";
  return { state, last };
}

export function AgentCards({ events, finished }: { events: RunEvent[]; finished: boolean }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {(["orchestrator", "develop", "testing"] as const).map((agent) => {
        const { state, last } = agentState(events, agent, finished);
        const s = STATE_LABEL[state];
        return (
          <div
            key={agent}
            className={`flex flex-col rounded-xl border bg-white p-4 shadow-sm ${
              state === "working" ? "border-emerald-400 ring-2 ring-emerald-100" : "border-slate-200"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">{AGENTS[agent].name}</h3>
              <span className={`flex items-center gap-1.5 text-xs font-medium ${s.className}`}>
                <span className={`h-2 w-2 rounded-full ${s.dot}`} />
                {s.label}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{AGENTS[agent].role}</p>
            <div className="mt-3 flex-1 rounded-md bg-slate-50 p-2.5 text-sm text-slate-700">
              {last ? (
                <>
                  <span className="mr-1 text-xs text-slate-400">{formatTime(last.created_at)}</span>
                  <span className="line-clamp-4">{last.message}</span>
                </>
              ) : (
                <span className="text-slate-400">Todavía no ha intervenido.</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
