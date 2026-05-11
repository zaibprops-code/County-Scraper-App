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
  PropertyMatchResult,
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

// Status banner type
interface Banner {
  text: string;
  ok: boolean;
}

// ---- Component ------------------------------------------------

export default function Dashboard() {
  const today = todayLocal();

  // Ingestion date range
  const [ingestFrom, setIngestFrom] = useState<string>(today);
  const [ingestTo, setIngestTo] = useState<string>(today);

  // Display filters
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);

  // Data state
  const [data, setData] = useState<LeadsApiResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  // Button loading states
  const [cronLoading, setCronLoading] = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [matchLoading, setMatchLoading] = useState(false);

  // Status banners
  const [banner, setBanner] = useState<Banner | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // ---- Fetch leads -------------------------------------------

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
    console.log("[Frontend] Fetching:", url);

    try {
      const res = await fetch(url, { signal: ctrl.signal });

      if (!res.ok) {
        setApiError(`API error ${res.status}`);
        setLoading(false);
        return;
      }

      const json = await res.json();
      console.log("[Frontend] probateTotal:", json.probateTotal, "foreclosureTotal:", json.foreclosureTotal);

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
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeads(filters);
  }, [filters, fetchLeads]);

  // ---- Run Ingestion -----------------------------------------

  const handleRunIngestion = async () => {
    if (!ingestFrom) {
      setBanner({ text: "Please select a start date.", ok: false });
      return;
    }
    const from = ingestFrom;
    const to = ingestTo || ingestFrom;
    if (to < from) {
      setBanner({ text: "End date must be on or after start date.", ok: false });
      return;
    }

    setCronLoading(true);
    setBanner(null);

    try {
      const params = new URLSearchParams({ dateFrom: from, dateTo: to });
      const res = await fetch(`/api/cron?${params}`);
      const json = await res.json();
      console.log("[Frontend] Cron:", json);

      if (json.success) {
        setBanner({
          text: `✓ Ingestion done! Files: ${json.filesProcessed} · Probate: ${json.probateLeadsInserted} · Foreclosure: ${json.foreclosureLeadsInserted}${json.message ? " · " + json.message : ""}`,
          ok: true,
        });
        setFilters({ ...DEFAULT_FILTERS });
      } else {
        setBanner({ text: `✗ ${json.error ?? json.message ?? "Unknown error"}`, ok: false });
      }
    } catch (err) {
      setBanner({ text: `✗ ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setCronLoading(false);
    }
  };

  // ---- Clear Records -----------------------------------------

  const handleClearRecords = async () => {
    if (!window.confirm("Delete ALL leads and processed files?\n\nThis cannot be undone.")) return;

    setClearLoading(true);
    setBanner(null);

    try {
      const res = await fetch("/api/clear", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        setData(EMPTY_RESPONSE);
        setFilters({ ...DEFAULT_FILTERS });
        setBanner({ text: "✓ All records cleared.", ok: true });
      } else {
        setBanner({ text: `✗ Clear failed: ${json.error ?? json.message}`, ok: false });
      }
    } catch (err) {
      setBanner({ text: `✗ ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setClearLoading(false);
    }
  };

  // ---- Match Probate Properties ------------------------------

  const handleMatchProperties = async () => {
    setMatchLoading(true);
    setBanner(null);
    console.log("[Frontend] Starting property matching...");

    try {
      const res = await fetch("/api/match-properties");
      const json: PropertyMatchResult = await res.json();
      console.log("[Frontend] Match result:", json);

      if (json.success) {
        setBanner({
          text: `✓ Property matching done! Processed: ${json.totalProcessed} · Matched: ${json.matched} · No match: ${json.noMatch} · Errors: ${json.errors}${json.message ? " · " + json.message : ""}`,
          ok: true,
        });
        // Refresh table to show newly matched addresses
        fetchLeads(filters);
      } else {
        setBanner({
          text: `✗ Matching failed: ${json.error ?? json.message ?? "Unknown error"}`,
          ok: false,
        });
      }
    } catch (err) {
      setBanner({ text: `✗ ${err instanceof Error ? err.message : String(err)}`, ok: false });
    } finally {
      setMatchLoading(false);
    }
  };

  const anyLoading = cronLoading || clearLoading || matchLoading;
  const totalLeads = data.probateTotal + data.foreclosureTotal;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* ---- Header ----------------------------------------- */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          {/* Title */}
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

          {/* Controls */}
          <div className="flex items-end gap-2 flex-wrap">
            {/* Date range */}
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                From
              </label>
              <input
                type="date"
                value={ingestFrom}
                onChange={(e) => setIngestFrom(e.target.value)}
                disabled={anyLoading}
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                To
              </label>
              <input
                type="date"
                value={ingestTo}
                onChange={(e) => setIngestTo(e.target.value)}
                disabled={anyLoading}
                min={ingestFrom}
                className="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:opacity-50"
              />
            </div>

            {/* Run Ingestion */}
            <ActionButton
              onClick={handleRunIngestion}
              disabled={anyLoading}
              loading={cronLoading}
              loadingText="Ingesting…"
              className="bg-cyan-600 hover:bg-cyan-500 text-white border-transparent"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              }
            >
              Run Ingestion
            </ActionButton>

            {/* Match Probate Properties */}
            <ActionButton
              onClick={handleMatchProperties}
              disabled={anyLoading}
              loading={matchLoading}
              loadingText="Matching…"
              className="border-emerald-700 text-emerald-400 hover:bg-emerald-900/40"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              }
            >
              Match Probate Properties
            </ActionButton>

            {/* Clear Records */}
            <ActionButton
              onClick={handleClearRecords}
              disabled={anyLoading}
              loading={clearLoading}
              loadingText="Clearing…"
              className="border-red-700 text-red-400 hover:bg-red-900/40"
              icon={
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              }
            >
              Clear Records
            </ActionButton>
          </div>
        </div>

        {/* Banner */}
        {banner && (
          <div className={`px-6 py-2 text-xs font-medium border-t flex items-center justify-between ${
            banner.ok
              ? "border-emerald-800 bg-emerald-950/60 text-emerald-400"
              : "border-red-800 bg-red-950/60 text-red-400"
          }`}>
            <span>{banner.text}</span>
            <button onClick={() => setBanner(null)} className="ml-4 opacity-60 hover:opacity-100 text-base leading-none">×</button>
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
          <StatCard label="Total Leads" value={totalLeads} accent="cyan"
            icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />}
          />
          <StatCard label="Probate Leads" value={data.probateTotal} accent="purple"
            icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />}
          />
          <StatCard label="Foreclosure Leads" value={data.foreclosureTotal} accent="orange"
            icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />}
          />
          <StatCard label="County" value="Hillsborough, FL" accent="emerald"
            icon={<><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></>}
          />
        </div>

        {/* Filter + export bar */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 flex flex-wrap gap-4 items-end justify-between">
          <FilterBar filters={filters} onChange={setFilters} loading={loading} />
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

        <footer className="text-center text-xs text-slate-700 pb-6">
          Data sourced from Hillsborough County Clerk public records ·{" "}
          <a href="https://publicrec.hillsclerk.com" target="_blank" rel="noopener noreferrer"
            className="hover:text-slate-500 transition">publicrec.hillsclerk.com
          </a>
        </footer>
      </main>
    </div>
  );
}

// ---- Shared ActionButton sub-component -----------------------

function ActionButton({
  children,
  onClick,
  disabled,
  loading,
  loadingText,
  className,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  loadingText: string;
  className: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg border transition disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {loading ? (
        <>
          <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          {loadingText}
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {icon}
          </svg>
          {children}
        </>
      )}
    </button>
  );
}
