import { useState, type ReactNode } from "react";
import type { Run } from "../shared/protocol";

const statusText: Record<Run["status"], string> = {
  running: "Running",
  completed: "Completed",
  stopped: "Stopped",
  error: "Error",
  interrupted: "Interrupted",
  "timed-out": "Timed out",
  imported: "Imported",
};
export function StatusBadge({ status }: { status: Run["status"] }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="badge-dot" aria-hidden />
      {statusText[status] ?? status}
    </span>
  );
}

export function Pill({
  tone = "neutral",
  children,
  pulse = false,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`pill tone-${tone}`}>
      <span className={`pill-dot ${pulse ? "pulse" : ""}`} aria-hidden />
      {children}
    </span>
  );
}

/** Horizontal meter: the fill carries severity, the track is a lighter step of the same hue. */
export function Meter({
  value,
  max,
  warnAt = 0.85,
  label,
}: {
  value: number;
  max: number;
  warnAt?: number;
  label: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      className={`meter ${ratio >= warnAt ? "warn" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
    >
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Metric({
  label,
  value,
  unit,
  note,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {children}
      {note !== undefined && <div className="metric-note">{note}</div>}
    </div>
  );
}

/** Small trend line in the de-emphasis ink with the current point in the accent. Hover reads a sample. */
export function Sparkline({
  points,
  format = (v: number) => v.toLocaleString(),
  onHover,
}: {
  points: { at: number; value: number }[];
  format?: (v: number) => string;
  onHover?: (text: string | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="spark spark-empty" />;
  const w = 120,
    h = 28,
    pad = 3;
  const values = points.map((p) => p.value);
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) =>
    max === min ? h / 2 : h - pad - ((v - min) / span) * (h - pad * 2);
  const d = points
    .map(
      (p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`,
    )
    .join("");
  const at = hover ?? points.length - 1;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(
          ((e.clientX - r.left) / r.width) * (points.length - 1),
        );
        const k = Math.max(0, Math.min(points.length - 1, i));
        setHover(k);
        const secondsAgo = Math.round((Date.now() - points[k].at) / 1000);
        onHover?.(`${format(points[k].value)} · ${secondsAgo}s ago`);
      }}
      onMouseLeave={() => {
        setHover(null);
        onHover?.(null);
      }}
    >
      <path d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
      <circle
        cx={x(at)}
        cy={y(points[at].value)}
        r={2.6}
        className="spark-dot"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Card({
  title,
  aside,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${flush ? "flush" : ""} ${className}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
