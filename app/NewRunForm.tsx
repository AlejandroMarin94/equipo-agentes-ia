"use client";

import { useActionState, useState } from "react";
import { createRun, type FormState } from "./actions";

const EXAMPLES = [
  "Añade una página de contacto con formulario",
  "Añade una sección de precios",
  "Añade un modo oscuro",
];

const initial: FormState = { error: null };

export function NewRunForm() {
  const [state, action, pending] = useActionState(createRun, initial);
  const [request, setRequest] = useState("");

  return (
    <form action={action} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <label htmlFor="request" className="block font-semibold text-slate-900">
        Nueva petición
      </label>
      <p className="mt-1 text-sm text-slate-600">
        Pide un cambio para la web de la «Panadería La Espiga». El Orquestador lo dividirá en tareas, Develop las hará
        y Testing las comprobará.
      </p>
      <textarea
        id="request"
        name="request"
        rows={3}
        required
        minLength={5}
        maxLength={500}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Por ejemplo: añade una página de contacto a esta web"
        className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setRequest(example)}
            className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
          >
            {example}
          </button>
        ))}
      </div>
      {state.error && <p className="mt-3 text-sm text-red-700">{state.error}</p>}
      <div className="mt-4 flex justify-end">
        <button
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Creando…" : "Lanzar a los agentes"}
        </button>
      </div>
    </form>
  );
}
