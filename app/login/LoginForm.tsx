"use client";

import { useActionState } from "react";
import { login, type FormState } from "@/app/actions";

const initial: FormState = { error: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(login, initial);
  return (
    <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
        />
      </div>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      <button
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
