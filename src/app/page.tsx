"use client";

import { useState, useEffect, useCallback } from "react";
import FilterBar from "@/components/FilterBar";
import LeadsTable from "@/components/LeadsTable";
import ExportButtons from "@/components/ExportButtons";
import StatCard from "@/components/StatCard";
import { FiltersState, LeadsApiResponse } from "@/types/leads";

const DEFAULT_FILTERS: FiltersState = {
  search: "",
  type: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
};

const EMPTY_RESPONSE: LeadsApiResponse = {
  probate: [],
  foreclosure: [],
  probateTotal: 0,
  foreclosureTotal: 0,
  page: 1,
  pageSize: 50,
};

export default function Dashboard() {
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [data, setData] = useState<LeadsApiResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(true);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronMessage, setCronMessage] = useState<string | null>(null);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        type: filters.type,
        search: filters.search,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        page: String(filters.page),
      });
      const res = await fetch(`/api/leads?${params}`);
      if (!res.ok) throw new Error("API error");
      const json: LeadsApiResponse = await res.json();
      setData(json);
    } catch {
      console.error("Failed to fetch leads");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleManualCron = async () => {
    setCronLoading(true);
    setCronMessage(null);
    try {
      const res = await fetch("/api/cron");
      const json = await res.json();
      if (json.success) {
        setCronMessage(
          `✓ Done! Files: ${json.filesProcessed} · Probate: ${json.probateLeadsInserted} · Foreclosure: ${json.foreclosureLeadsInserted}`
        );
        fetchLeads();
      } else {
        setCronMessage(`✗ ${json.error ?? json.message}`);
      }
    } catch {
      setCronMessage("✗ Failed to trigger ingestion");
    } finally {
      setCronLoading(false);
    }
  };

  const totalLeads = data.probateTotal + data.foreclosureTotal;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---- Header ---- */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white font-bold text-sm">
              H
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100 tracking-tight">
                Hillsborough County Lead Generator
              </h1>
              <p className="text-xs text-slate-500">
                Probate &amp; Foreclosure · Florida · MVP
              </p>
            </div>
          </div>

          <button
            onClick={handleManualCron}
            disabled={cronLoading}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-400 transition disabled:opacity-50"
          >
            {cronLoading ? (
              <>
                <span className="w-3 h-3 border border-cyan-500 border-t-transparent rounded-full animate-spin" />
                Ingesting…
              </>
            ) : (
              <>
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Run Ingestion
              </>
            )}
          </button>
        </div>

        {/* Cron status banner */}
        {cronMessage && (
          <div
            className={`px-6 py-2 text-xs font-medium border-t ${
              cronMessage.startsWith("✓")
                ? "border-emerald-800 bg-emerald-950/60 text-emerald-400"
                : "border-red-800 bg-red-950/60 text-red-400"
            }`}
          >
            {cronMessage}
            <button
              onClick={() => setCronMessage(null)}
              className="ml-4 opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </div>
        )}
      </header>

      {/* ---- Main ---- */}
      <main className="max-w-screen-xl mx-auto px-6 py-8 space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Leads"
            value={totalLeads}
            accent="cyan"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
          <StatCard
            label="Probate Leads"
            value={data.probateTotal}
            accent="purple"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            }
          />
          <StatCard
            label="Foreclosure Leads"
            value={data.foreclosureTotal}
            accent="orange"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            }
          />
          <StatCard
            label="County"
            value="Hillsborough, FL"
            accent="emerald"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
        </div>

        {/* Controls bar */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-wrap gap-4 items-end justify-between">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            loading={loading}
          />
          <ExportButtons filters={filters} totalLeads={totalLeads} />
        </div>

        {/* Table */}
        <LeadsTable
          probate={data.probate}
          foreclosure={data.foreclosure}
          probateTotal={data.probateTotal}
          foreclosureTotal={data.foreclosureTotal}
          page={filters.page}
          pageSize={data.pageSize}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          loading={loading}
        />

        {/* Footer */}
        <footer className="text-center text-xs text-slate-700 pb-6">
          Data sourced from Hillsborough County Clerk public records ·{" "}
          <a
            href="https://publicrec.hillsclerk.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-500 transition"
          >
            publicrec.hillsclerk.com
          </a>
        </footer>
      </main>
    </div>
  );
}
