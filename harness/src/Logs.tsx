import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { LogEntry } from "../shared/protocol";
import { clock } from "./format";

type Filter = "all" | "agent" | "tool" | "action" | "error";
const filters: { id: Filter; name: string }[] = [
  { id: "all", name: "All" },
  { id: "agent", name: "Agent" },
  { id: "tool", name: "Tools" },
  { id: "action", name: "Inputs" },
  { id: "error", name: "Errors" },
];

/** "system" entries that start with "Using " are tool calls; everything else keeps its kind. */
function category(entry: LogEntry): Exclude<Filter, "all"> | "system" | "user" {
  if (entry.kind === "system" && entry.text.startsWith("Using ")) return "tool";
  return entry.kind;
}

/** Render a logged game input compactly: {"type":"click","x":8,"y":9} → "click · 8, 9". */
function describeAction(text: string) {
  try {
    const a = JSON.parse(text) as Record<string, unknown>;
    const type = String(a.type ?? "input");
    const button = a.button === 3 ? " · right" : "";
    if (type === "click") return `click · ${a.x}, ${a.y}${button}`;
    if (type === "drag")
      return `drag · ${a.x}, ${a.y} → ${a.endX}, ${a.endY}${button}`;
    if (type === "scroll") return `scroll ${a.direction} · ${a.x}, ${a.y}`;
    if (type === "key") return `key · ${a.key}`;
    if (type === "hotkey") return `hotkey · ${a.name}`;
    const rest = Object.entries(a)
      .filter(([k]) => k !== "type")
      .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
    return rest ? `${type} · ${rest}` : type;
  } catch {
    return text;
  }
}

const kindName: Record<string, string> = {
  agent: "Agent",
  tool: "Tool",
  action: "Input",
  error: "Error",
  system: "System",
  user: "User",
};

export function Logs({
  entries,
  streaming = "",
  searchable = false,
  emptyText = "No activity yet.",
}: {
  entries: LogEntry[];
  streaming?: string;
  searchable?: boolean;
  emptyText?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[category(e)] = (c[category(e)] ?? 0) + 1;
    return c;
  }, [entries]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === "all" || category(e) === filter) &&
        (!q || e.text.toLowerCase().includes(q)),
    );
  }, [entries, filter, query]);
  // Follow new entries only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, streaming]);
  return (
    <div className="logs">
      <div className="log-tools">
        <div className="segmented" role="tablist" aria-label="Filter activity">
          {filters.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? "on" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.name}
              <span className="count">{counts[f.id] ?? 0}</span>
            </button>
          ))}
        </div>
        {searchable && (
          <label className="search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              placeholder="Search logs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
      </div>
      <div
        className="feed"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 && !streaming && (
          <p className="empty">
            {entries.length ? "Nothing matches this filter." : emptyText}
          </p>
        )}
        {shown.map((entry) => {
          const kind = category(entry);
          return (
            <article key={entry.id} className={`entry k-${kind}`}>
              <time dateTime={new Date(entry.at).toISOString()}>
                {clock(entry.at)}
              </time>
              <span className="entry-kind">{kindName[kind] ?? kind}</span>
              <p>
                {kind === "action"
                  ? describeAction(entry.text)
                  : kind === "tool"
                    ? entry.text.slice(6)
                    : entry.text}
              </p>
            </article>
          );
        })}
        {streaming && (filter === "all" || filter === "agent") && (
          <article className="entry k-agent streaming">
            <time>now</time>
            <span className="entry-kind">Agent</span>
            <p>
              {streaming}
              <span className="caret" aria-hidden />
            </p>
          </article>
        )}
      </div>
    </div>
  );
}
