"use client";

interface StatCardProps {
  label: string;
  value: string | number;
  accent: "cyan" | "purple" | "orange" | "emerald";
  icon: React.ReactNode;
}

const accents = {
  cyan: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-500/10",
    text: "text-cyan-400",
    dot: "bg-cyan-400",
  },
  purple: {
    border: "border-purple-500/30",
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    dot: "bg-purple-400",
  },
  orange: {
    border: "border-orange-500/30",
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    dot: "bg-orange-400",
  },
  emerald: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
  },
};

export default function StatCard({ label, value, accent, icon }: StatCardProps) {
  const a = accents[accent];
  return (
    <div
      className={`relative rounded-xl border ${a.border} ${a.bg} p-5 overflow-hidden`}
    >
      <div className={`absolute top-4 right-4 ${a.text} opacity-60`}>{icon}</div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-2">
        {label}
      </p>
      <p className={`text-3xl font-bold tracking-tight ${a.text}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
