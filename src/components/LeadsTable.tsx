"use client";

import { useState } from "react";
import { ProbateLead, ForeclosureLead } from "@/types/leads";

interface LeadsTableProps {
  probate: ProbateLead[];
  foreclosure: ForeclosureLead[];
  probateTotal: number;
  foreclosureTotal: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  loading: boolean;
}

type Tab = "probate" | "foreclosure";

export default function LeadsTable({
  probate,
  foreclosure,
  probateTotal,
  foreclosureTotal,
  page,
  pageSize,
  onPageChange,
  loading,
}: LeadsTableProps) {
  const [tab, setTab] = useState<Tab>("probate");

  const isForeclosure = tab === "foreclosure";
  const rows = isForeclosure ? foreclosure : probate;
  const total = isForeclosure ? foreclosureTotal : probateTotal;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900/50 backdrop-blur-sm">
      {/* Tab strip */}
      <div className="flex border-b border-slate-800">
        <TabButton
          active={tab === "probate"}
          onClick={() => setTab("probate")}
          label="Probate"
          count={probateTotal}
          color="purple"
        />
        <TabButton
          active={tab === "foreclosure"}
          onClick={() => setTab("foreclosure")}
          label="Foreclosure"
          count={foreclosureTotal}
          color="orange"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60">
                {isForeclosure ? (
                  <>
                    <TH>Case #</TH>
                    <TH>Filed</TH>
                    <TH>Type</TH>
                    <TH>Defendant</TH>
                    <TH>Plaintiff</TH>
                    <TH>Attorney</TH>
                    <TH>Address</TH>
                    <TH>City</TH>
                    <TH>ZIP</TH>
                  </>
                ) : (
                  <>
                    <TH>Case #</TH>
                    <TH>Filed</TH>
                    <TH>Type</TH>
                    <TH>Deceased</TH>
                    <TH>Petitioner</TH>
                    <TH>Attorney</TH>
                    <TH>Mailing Address</TH>
                    <TH>City</TH>
                    <TH>ZIP</TH>
                    <TH title="Matched from Hillsborough Property Appraiser">
                      Matched Property
                    </TH>
                    <TH>Prop. City</TH>
                    <TH>Prop. ZIP</TH>
                    <TH>Match</TH>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {isForeclosure
                ? (rows as ForeclosureLead[]).map((row, i) => (
                    <tr key={row.id ?? i} className="hover:bg-slate-800/40 transition-colors">
                      <TD mono>{row.case_number}</TD>
                      <TD>{row.filing_date ?? "—"}</TD>
                      <TD><Badge type="orange">{row.case_type ?? "—"}</Badge></TD>
                      <TD>{row.defendant ?? "—"}</TD>
                      <TD muted>{row.plaintiff ?? "—"}</TD>
                      <TD muted>{row.attorney ?? "—"}</TD>
                      <TD muted>{row.address ?? "—"}</TD>
                      <TD muted>{row.city ?? "—"}</TD>
                      <TD mono muted>{row.zip ?? "—"}</TD>
                    </tr>
                  ))
                : (rows as ProbateLead[]).map((row, i) => (
                    <tr key={row.id ?? i} className="hover:bg-slate-800/40 transition-colors">
                      <TD mono>{row.case_number}</TD>
                      <TD>{row.filing_date ?? "—"}</TD>
                      <TD><Badge type="purple">{row.case_type ?? "—"}</Badge></TD>
                      <TD>{row.deceased_name ?? "—"}</TD>
                      <TD muted>{row.petitioner ?? "—"}</TD>
                      <TD muted>{row.attorney ?? "—"}</TD>
                      <TD muted>{row.address ?? "—"}</TD>
                      <TD muted>{row.city ?? "—"}</TD>
                      <TD mono muted>{row.zip ?? "—"}</TD>

                      {/* Matched property columns */}
                      <TD>
                        {row.matched_property_address ? (
                          <span className="text-emerald-400">{row.matched_property_address}</span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </TD>
                      <TD muted>{row.matched_property_city ?? "—"}</TD>
                      <TD mono muted>{row.matched_property_zip ?? "—"}</TD>
                      <TD>
                        <MatchStatusBadge status={row.property_match_status ?? null} />
                      </TD>
                    </tr>
                  ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && total > 0 && (
        <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            Showing {from}–{to} of{" "}
            <span className="text-slate-300 font-semibold">{total.toLocaleString()}</span> leads
          </span>
          <div className="flex items-center gap-2">
            <PaginationButton onClick={() => onPageChange(page - 1)} disabled={page <= 1} label="← Prev" />
            <span className="text-xs text-slate-500 px-2">{page} / {totalPages}</span>
            <PaginationButton onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} label="Next →" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Sub-components ------------------------------------------

function TabButton({
  active, onClick, label, count, color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color: "purple" | "orange";
}) {
  const activeStyles =
    color === "purple"
      ? "text-purple-400 border-b-2 border-purple-400 bg-purple-500/5"
      : "text-orange-400 border-b-2 border-orange-400 bg-orange-500/5";

  return (
    <button
      onClick={onClick}
      className={`px-6 py-4 text-sm font-semibold transition-all ${
        active ? activeStyles : "text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
      <span className={`ml-2.5 px-2 py-0.5 rounded-full text-xs font-bold ${
        active
          ? color === "purple" ? "bg-purple-500/20 text-purple-300" : "bg-orange-500/20 text-orange-300"
          : "bg-slate-800 text-slate-500"
      }`}>
        {count.toLocaleString()}
      </span>
    </button>
  );
}

function TH({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <th
      title={title}
      className="px-4 py-3 text-left text-xs font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap"
    >
      {children}
    </th>
  );
}

function TD({ children, mono, muted }: { children: React.ReactNode; mono?: boolean; muted?: boolean }) {
  return (
    <td className={`px-4 py-3 whitespace-nowrap ${mono ? "font-mono text-xs" : "text-sm"} ${muted ? "text-slate-400" : "text-slate-200"}`}>
      {children}
    </td>
  );
}

function Badge({ children, type }: { children: React.ReactNode; type: "purple" | "orange" }) {
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${
      type === "purple" ? "bg-purple-500/15 text-purple-300" : "bg-orange-500/15 text-orange-300"
    }`}>
      {children}
    </span>
  );
}

function MatchStatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-slate-700 text-xs">—</span>;

  const styles: Record<string, string> = {
    matched: "bg-emerald-500/15 text-emerald-400",
    no_match: "bg-slate-700 text-slate-500",
    error: "bg-red-500/15 text-red-400",
  };

  const labels: Record<string, string> = {
    matched: "✓ Match",
    no_match: "No Match",
    error: "Error",
  };

  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${styles[status] ?? "bg-slate-700 text-slate-500"}`}>
      {labels[status] ?? status}
    </span>
  );
}

function PaginationButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
    >
      {label}
    </button>
  );
}

function LoadingRows() {
  return (
    <div className="py-20 flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-sm text-slate-500">Loading leads…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-20 text-center">
      <div className="text-4xl mb-3">📭</div>
      <p className="text-slate-400 text-sm font-medium">No leads found</p>
      <p className="text-slate-600 text-xs mt-1">
        Select a date range and click Run Ingestion.
      </p>
    </div>
  );
}
