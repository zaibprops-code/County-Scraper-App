"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import FilterBar from "@/components/FilterBar";
import LeadsTable from "@/components/LeadsTable";
import ExportButtons from "@/components/ExportButtons";
import StatCard from "@/components/StatCard";
import {
  FiltersState,
  LeadsApiResponse,
  ProbateLead,
  ForeclosureLead,
} from "@/types/leads";

// ---- Helpers --------------------------------------------------

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const EMPTY_RESPONSE: LeadsApiResponse = {
  probate: [],
  foreclosure: [],
  probateTotal: 0,
  foreclosureTotal: 0,
  page: 1,
  pageSize: 50,
};

const DEFAULT_FILTERS: FiltersState = {
  search: "",
  type: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
};

// ---- Component ------------------------------------------------

export default function Dashboard() {
  const today = todayLocal();

  // Ingestion date range (separate from display filters)
  const [ingestFrom, setIngestFrom] = useState<string>(today);
  const [ingestTo, setIngestTo] = useState<string>(today);

  // Display filters
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);

  // Data state
  const [data, setData] = useState<LeadsApiResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  // Action states
  const [cronLoading, setCronLoading] = useState(false);
  const [cronMessage, setCronMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [clearLoading, setClearLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // ---- Fetch leads from /api/leads ---------------------------

  const fetchLeads = useCallback(async (f: FiltersState) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setApiError(null);

    const params = new URLSearchParams({
      type: f.type,
      search: f.search,
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
      page: String(f.page),
    });

    const url = `/api/leads?${params}`;
    console.log("[Frontend] Fetching leads:", url);

    try {
      const res = await fetch(url, { signal: ctrl.signal });

      if (!res.ok) {
        const text = await res.text();
        console.error("[Frontend] API error:", res.status, text);
        setApiError(`API error ${res.status}`);
        setLoading(false);
        return;
      }

      const json = await res.json();
      console.log("[Frontend] Response — probateTotal:", json.probateTotal, "foreclosureTotal:", json.foreclosureTotal);

      setData({
        probate: Array.isArray(json.probate) ? (json.probate as ProbateLead[]) : [],
        foreclosure: Array.isArray(json.foreclosure) ? (json.foreclosure as ForeclosureLead[]) : [],
        probateTotal: typeof json.probateTotal === "number" ? json.probateTotal : 0,
        foreclosureTotal: typeof json.foreclosureTotal === "number" ? json.foreclosureTotal : 0,
        page: typeof json.page === "number" ? json.page : 1,
        pageSize: typeof json.pageSize === "number" ? json.pageSize : 50,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Frontend] Fetch error:", msg);
      setApiError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch whenever display filters change
  useEffect(() => {
    fetchLeads(filters);
  }, [filters, fetchLeads]);

  // ---- Run Ingestion -----------------------------------------

  const handleRunIngestion = async () => {
    if (!ingestFrom) {
      setCronMessage({ text: "Please select a start date.", ok: false });
      return;
    }

    const from = ingestFrom;
    const to = ingestTo || ingestFrom;

    if (to < from) {
      setCronMessage({ text: "End date must be on or after start date.", ok: false });
      return;
    }

    setCronLoading(true);
    setCronMessage(null);

    const params = new URLSearchParams({ dateFrom: from, dateTo: to });
    const url = `/api/cron?${params}`;
    console.log("[Frontend] Triggering ingestion:", url);

    try {
      const res = await fetch(url);
      const json = await res.json();
      console.log("[Frontend] Cron response:", json);

      if (json.success) {
        setCronMessage({
          text: `✓ Done! Files: ${json.filesProcessed} · Probate: ${json.probateLeadsInserted} · Foreclosure: ${json.foreclosureLeadsInserted}${json.message ? " · " + json.message : ""}`,
          ok: true,
        });
        // Refresh display with fresh data (no date filter — show everything just inserted)
        setFilters({ ...DEFAULT_FILTERS });
      } else {
        setCronMessage({ text: `✗ ${json.error ?? json.message ?? "Unknown error"}`, ok: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCronMessage({ text: `✗ ${msg}`, ok: false });
    } finally {
      setCronLoading(false);
    }
  };

  // ---- Clear Records -----------------------------------------

  const handleClearRecords = async () => {
    const confirmed = window.confirm(
      "Are you sure you want to delete ALL leads and processed files?\n\nThis cannot be undone."
    );
    if (!confirmed) return;

    setClearLoading(true);
    setCronMessage(null);
    console.log("[Frontend] Clearing all records...");

    try {
      const res = await fetch("/api/clear", { method: "POST" });
      const json = await res.json();
      console.log("[Frontend] Clear response:", json);

      if (json.success) {
        setData(EMPTY_RESPONSE);
        setFilters({ ...DEFAULT_FILTERS });
        setCronMessage({ text: "✓ All records cleared.", ok: true });
      } else {
        setCronMessage({ text: `✗ Clear failed: ${json.error ?? json.message}`, ok: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCronMessage({ text: `✗ ${msg}`, ok: false });
    } finally {
      setClearLoading(false);
    }
  };

  const totalLeads = data.probateTotal + data.foreclosureTotal;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---- Header ----------------------------------------- */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
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

          {/* ---- Ingestion controls -------------------------- */}
          <div className="flex items-end gap-3 flex-wrap">
            {/* Date range inputs */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                From Date
              </label>
              <input
                type="date"
                value={ingestFrom}
                onChange={(e) => setIngestFrom(e.target.value)}
                disabled={cronLoading}
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                To Date
              </label>
              <input
                type="date"
                value={ingestTo}
                onChange={(e) => setIngestTo(e.target.value)}
                disabled={cronLoading}
                min={ingestFrom}
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
              />
            </div>

            {/* Run ingestion */}
            <button
              onClick={handleRunIngestion}
              disabled={cronLoading || clearLoading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {cronLoading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Ingesting…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Run Ingestion
                </>
              )}
            </button>

            {/* Clear records */}
            <button
              onClick={handleClearRecords}
              disabled={cronLoading || clearLoading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg border border-red-700 text-red-400 hover:bg-red-900/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearLoading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                  Clearing…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Clear Records
                </>
              )}
            </button>
          </div>
        </div>

        {/* Status banner */}
        {cronMessage && (
          <div className={`px-6 py-2 text-xs font-medium border-t flex items-center justify-between ${
            cronMessage.ok
              ? "border-emerald-800 bg-emerald-950/60 text-emerald-400"
              : "border-red-800 bg-red-950/60 text-red-400"
          }`}>
            <span>{cronMessage.text}</span>
            <button onClick={() => setCronMessage(null)} className="ml-4 opacity-60 hover:opacity-100 text-base leading-none">×</button>
          </div>
        )}

        {apiError && (
          <div className="px-6 py-2 text-xs font-medium border-t border-red-800 bg-red-950/60 text-red-400 flex items-center justify-between">
            <span>API Error: {apiError}</span>
            <button onClick={() => setApiError(null)} className="ml-4 opacity-60 hover:opacity-100 text-base leading-none">×</button>
          </div>
        )}
      </header>

      {/* ---- Main ------------------------------------------- */}
      <main className="max-w-screen-xl mx-auto px-6 py-8 space-y-6">

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Leads"
            value={totalLeads}
            accent="cyan"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
          <StatCard
            label="Probate Leads"
            value={data.probateTotal}
            accent="purple"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            }
          />
          <StatCard
            label="Foreclosure Leads"
            value={data.foreclosureTotal}
            accent="orange"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            }
          />
          <StatCard
            label="County"
            value="Hillsborough, FL"
            accent="emerald"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
        </div>

        {/* Filter + export bar */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-wrap gap-4 items-end justify-between">
          <FilterBar filters={filters} onChange={setFilters} loading={loading} />
          <ExportButtons filters={filters} totalLeads={totalLeads} />
        </div>

        {/* Leads table */}
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

        <footer className="text-center text-xs text-slate-700 pb-6">
          Data sourced from Hillsborough County Clerk public records ·{" "}
          <a href="https://publicrec.hillsclerk.com" target="_blank" rel="noopener noreferrer"
            className="hover:text-slate-500 transition">
            publicrec.hillsclerk.com
          </a>
        </footer>
      </main>
    </div>
  );
}
