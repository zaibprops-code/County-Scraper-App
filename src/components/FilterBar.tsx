"use client";

import { FiltersState } from "@/types/leads";

interface FilterBarProps {
  filters: FiltersState;
  onChange: (f: FiltersState) => void;
  loading: boolean;
}

export default function FilterBar({
  filters,
  onChange,
  loading,
}: FilterBarProps) {
  const set = (patch: Partial<FiltersState>) =>
    onChange({ ...filters, ...patch, page: 1 });

  const handleReset = () =>
    onChange({ search: "", type: "all", dateFrom: "", dateTo: "", page: 1 });

  const hasActiveFilters =
    filters.search || filters.type !== "all" || filters.dateFrom || filters.dateTo;

  return (
    <div className="flex flex-wrap gap-3 items-end">
      {/* Search */}
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Search
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
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
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </span>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Name, case number, attorney…"
            disabled={loading}
            className="w-full pl-9 pr-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:opacity-50 transition"
          />
        </div>
      </div>

      {/* Lead type */}
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Lead Type
        </label>
        <select
          value={filters.type}
          onChange={(e) =>
            set({ type: e.target.value as FiltersState["type"] })
          }
          disabled={loading}
          className="px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:opacity-50 transition"
        >
          <option value="all">All Leads</option>
          <option value="probate">Probate Only</option>
          <option value="foreclosure">Foreclosure Only</option>
        </select>
      </div>

      {/* Date From */}
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          From Date
        </label>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => set({ dateFrom: e.target.value })}
          disabled={loading}
          className="px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:opacity-50 transition"
        />
      </div>

      {/* Date To */}
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          To Date
        </label>
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => set({ dateTo: e.target.value })}
          disabled={loading}
          className="px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent disabled:opacity-50 transition"
        />
      </div>

      {/* Clear */}
      {hasActiveFilters && (
        <button
          onClick={handleReset}
          disabled={loading}
          className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 border border-slate-700 rounded-lg transition hover:border-slate-500 disabled:opacity-50"
        >
          Clear
        </button>
      )}
    </div>
  );
}
