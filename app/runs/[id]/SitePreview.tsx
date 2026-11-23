"use client";

import { useState } from "react";
import { formatTime } from "@/lib/format";
import type { RunFile } from "@/lib/types";

export function SitePreview({ runId, files }: { runId: string; files: RunFile[] }) {
  const pages = files.map((f) => f.path).filter((p) => p.endsWith(".html"));
  const [page, setPage] = useState("index.html");
  const [tab, setTab] = useState<"preview" | "files">("preview");
  const [selected, setSelected] = useState("index.html");

  const currentPage = pages.includes(page) ? page : (pages[0] ?? "index.html");
  const selectedFile = files.find((f) => f.path === selected) ?? files[0];
  // Cambia cuando cambia cualquier archivo, para recargar la vista previa.
  const version = files.reduce((max, f) => (f.updated_at > max ? f.updated_at : max), "");
  const src = `/api/runs/${runId}/site/${currentPage}?v=${encodeURIComponent(version)}`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2">
        {(["preview", "files"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {t === "preview" ? "Vista previa" : `Archivos (${files.length})`}
          </button>
        ))}
        {tab === "preview" && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <select
              value={currentPage}
              onChange={(e) => setPage(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1"
              aria-label="Página"
            >
              {pages.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <a href={src} target="_blank" rel="noreferrer" className="text-slate-600 underline">
              Abrir
            </a>
          </div>
        )}
      </div>

      {tab === "preview" ? (
        <iframe
          key={src}
          src={src}
          title="Vista previa de la web"
          sandbox="allow-scripts allow-forms allow-modals"
          className="h-[32rem] w-full rounded-b-xl bg-white"
        />
      ) : (
        <div className="flex flex-col md:flex-row">
          <ul className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 p-2 md:w-52 md:flex-col md:border-r md:border-b-0">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  onClick={() => setSelected(f.path)}
                  className={`w-full rounded-md px-2 py-1 text-left font-mono text-xs whitespace-nowrap ${
                    selectedFile?.path === f.path ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
          {selectedFile && (
            <div className="min-w-0 flex-1">
              <p className="px-3 pt-2 text-xs text-slate-500">
                Actualizado a las {formatTime(selectedFile.updated_at)}
              </p>
              <pre className="h-[30rem] overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800">
                {selectedFile.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
