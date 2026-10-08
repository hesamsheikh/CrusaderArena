import { useState } from "react";
import type { Stats } from "../shared/protocol";
import { Card, Pill, Sparkline } from "./ui";
import { label, monthName } from "./format";

type Observation = NonNullable<Stats["observation"]>;
export type Sample = {
  at: number;
  gold: number;
  population: number;
  popularity: number;
  food: number;
};

const groups: { name: string; keys: string[] }[] = [
  { name: "Materials", keys: ["wood_planks", "stone", "iron", "pitch"] },
  {
    name: "Food",
    keys: [
      "bread",
      "cheese",
      "meat",
      "apples",
      "wheat",
      "flour",
      "hops",
      "ale",
    ],
  },
  {
    name: "Arms",
    keys: [
      "bows",
      "crossbows",
      "spears",
      "pikes",
      "maces",
      "swords",
      "leather_armour",
      "metal_armour",
    ],
  },
];

function Tile({
  name,
  value,
  sub,
  trend,
  field,
}: {
  name: string;
  value: number | undefined;
  sub?: string;
  trend: Sample[];
  field?: keyof Omit<Sample, "at">;
}) {
  const points = field
    ? trend
        .filter((s) => Number.isFinite(s[field]))
        .map((s) => ({ at: s.at, value: s[field] }))
    : [];
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="tile">
      <div className="tile-label">{name}</div>
      <div className="tile-value">
        {typeof value === "number" ? value.toLocaleString() : "—"}
      </div>
      {field && typeof value === "number" ? (
        <Sparkline points={points} onHover={setHover} />
      ) : (
        <div className="spark spark-empty" />
      )}
      <div className="tile-sub">{hover ?? sub ?? " "}</div>
    </div>
  );
}

export function Kingdom({
  stats,
  readingAge,
  history,
  connected,
}: {
  stats: Observation | null;
  /** Seconds since the shown reading was fresh; 0 while the reader is live. */
  readingAge: number;
  history: Sample[];
  connected: boolean;
}) {
  const s = stats?.settlement;
  const resources = stats?.resources_by_name ?? {};
  const factors = Object.entries(s?.popularity_factors ?? {}).filter(
    ([, v]) => v,
  );
  const troops = Object.entries(
    (stats?.own_troops as { by_type?: Record<string, number> } | undefined)
      ?.by_type ?? {},
  ).filter(([, v]) => v > 0);
  const paused = stats?.paused || stats?.is_paused;
  // Settlement factors are in engine units; 25 make one popularity point per month.
  const monthly = s ? s.upcoming_popularity / 25 : null;
  return (
    <Card
      className="kingdom"
      title={
        <>
          Kingdom
          {stats ? (
            readingAge > 2 ? (
              <Pill>Last reading {readingAge}s ago</Pill>
            ) : paused ? (
              <Pill tone="warn">Game paused</Pill>
            ) : (
              <Pill tone="good">Reader live</Pill>
            )
          ) : (
            <Pill>{connected ? "Awaiting a map" : "No reading"}</Pill>
          )}
        </>
      }
      aside={
        stats && (
          <span className="muted">
            {stats.map_name}
            {s && ` · ${monthName(s.month)} ${s.year}`}
          </span>
        )
      }
    >
      <div className="tiles">
        <Tile
          name="Gold"
          value={stats?.gold}
          trend={history}
          field="gold"
          sub={stats ? `Tax level ${stats.tax_index ?? "—"}` : undefined}
        />
        <Tile
          name="Population"
          value={stats?.population}
          trend={history}
          field="population"
          sub={
            s
              ? `${s.housing_cap} housing · ${s.peasants_available} idle`
              : undefined
          }
        />
        <Tile
          name="Popularity"
          value={stats?.popularity}
          trend={history}
          field="popularity"
          sub={
            monthly !== null
              ? `${monthly >= 0 ? "+" : "−"}${Math.abs(monthly).toLocaleString(undefined, { maximumFractionDigits: 1 })} next month`
              : undefined
          }
        />
        <Tile
          name="Food"
          value={s?.total_food}
          trend={history}
          field="food"
          sub={
            s
              ? `${s.months_of_food} months · ${s.food_types_eaten} of ${s.food_types_available} types`
              : undefined
          }
        />
        <Tile
          name="Troops"
          value={stats?.own_troops?.total}
          trend={history}
          sub={
            troops.length
              ? troops
                  .map(([k, v]) => `${v} ${label(k).toLowerCase()}`)
                  .join(", ")
              : stats
                ? "No units"
                : undefined
          }
        />
      </div>
      {stats && (
        <div className="kingdom-detail">
          <div className="stock">
            {groups.map((g) => (
              <div className="stock-group" key={g.name}>
                <h3>{g.name}</h3>
                <dl>
                  {g.keys.map((k) => (
                    <div key={k} className={resources[k] ? "" : "zero"}>
                      <dt>{label(k).replace(" planks", "")}</dt>
                      <dd>{(resources[k] ?? 0).toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          <div className="factors">
            <h3>Popularity factors</h3>
            {factors.length ? (
              <ul>
                {factors.map(([k, v]) => {
                  const points = v / 25;
                  const width = Math.min(50, Math.abs(points) * 10);
                  return (
                    <li key={k}>
                      <span>{label(k)}</span>
                      <span className="factor-bar" aria-hidden>
                        <span
                          className={points >= 0 ? "pos" : "neg"}
                          style={{ width: `${width}%` }}
                        />
                      </span>
                      <strong>
                        {points >= 0 ? "+" : "−"}
                        {Math.abs(points).toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })}
                      </strong>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">No active factors.</p>
            )}
            {s && (
              <p className="muted small">
                Rationing {s.rationing} · Efficiency {s.efficiency}%
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
