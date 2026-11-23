import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Entrar · Equipo de agentes IA" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Equipo de agentes IA</h1>
        <p className="mt-1 mb-6 text-sm text-slate-600">
          Un Orquestador, un Develop y un Testing que trabajan juntos sobre una web de ejemplo.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
