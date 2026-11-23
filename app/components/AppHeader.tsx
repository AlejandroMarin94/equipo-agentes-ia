import Link from "next/link";
import { logout } from "@/app/actions";

export function AppHeader({ email }: { email?: string | null }) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold text-slate-900">
          Equipo de agentes IA
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {email && <span className="hidden text-slate-500 sm:inline">{email}</span>}
          <form action={logout}>
            <button className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
              Salir
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
