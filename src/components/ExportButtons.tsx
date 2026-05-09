"use client";

import { FiltersState } from "@/types/leads";

interface ExportButtonsProps {
  filters: FiltersState;
  totalLeads: number;
}

export default function ExportButtons({
  filters,
  totalLeads,
}: ExportButtonsProps) {
  const disabled = totalLeads === 0;

  function buildUrl(format: "csv" | "xlsx") {
    const p = new URLSearchParams({
      format,
      type: filters.type,
      search: filters.search,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    });
    return `/api/export?${p.toString()}`;
  }

  return (
    <div className="flex gap-2">
      <a
        href={disabled ? undefined : buildUrl("csv")}
        download={!disabled}
        aria-disabled={disabled}
        className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border transition-all ${
          disabled
            ? "border-slate-700 text-slate-600 cursor-not-allowed"
            : "border-emerald-500 text-emerald-400 hover:bg-emerald-500 hover:text-slate-900 cursor-pointer"
        }`}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        CSV
      </a>

      <a
        href={disabled ? undefined : buildUrl("xlsx")}
        download={!disabled}
        aria-disabled={disabled}
        className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg border transition-all ${
          disabled
            ? "border-slate-700 text-slate-600 cursor-not-allowed"
            : "border-cyan-500 text-cyan-400 hover:bg-cyan-500 hover:text-slate-900 cursor-pointer"
        }`}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        Excel
      </a>
    </div>
  );
}
