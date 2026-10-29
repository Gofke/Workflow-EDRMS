/**
 * Small charts drawn as SVG: bars for comparing, a line for change over time.
 * Every chart has a text alternative, and its numbers are also in a table on
 * the report it belongs to.
 */
export interface Series {
  name: string;
  color: string;
  values: number[];
}

export function BarChart({ labels, series, height = 220, stacked = false, title }: { labels: string[]; series: Series[]; height?: number; stacked?: boolean; title: string }) {
  const width = 640;
  const pad = { l: 38, r: 8, t: 10, b: 32 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(...series.map((s) => s.values[i] ?? 0))));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const group = innerW / Math.max(labels.length, 1);
  const barW = stacked ? Math.min(34, group * 0.6) : Math.min(22, (group * 0.75) / series.length);
  const ticks = [0, nice / 2, nice];
  // With many bars, name every few so the labels never run into each other; the last is always named.
  const every = Math.max(1, Math.ceil(labels.length / 8));
  const named = (i: number) => i === labels.length - 1 || (i % every === 0 && labels.length - 1 - i >= every * 0.6);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {ticks.map((v) => {
          const y = pad.t + innerH - (v / nice) * innerH;
          return (
            <g key={v}>
              <line className="axis" x1={pad.l} x2={width - pad.r} y1={y} y2={y} strokeDasharray={v === 0 ? undefined : '3 4'} />
              <text x={pad.l - 6} y={y + 4} textAnchor="end">
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        {labels.map((label, i) => {
          const x0 = pad.l + i * group + group / 2;
          let acc = 0;
          return (
            <g key={label + i}>
              {series.map((s, j) => {
                const v = s.values[i] ?? 0;
                const h = (v / nice) * innerH;
                if (stacked) {
                  const y = pad.t + innerH - ((acc + v) / nice) * innerH;
                  acc += v;
                  return <rect key={s.name} x={x0 - barW / 2} y={y} width={barW} height={h} fill={s.color} rx={1.5}><title>{`${label} — ${s.name}: ${v}`}</title></rect>;
                }
                const x = x0 - (barW * series.length) / 2 + j * barW;
                return <rect key={s.name} x={x + 1} y={pad.t + innerH - h} width={barW - 2} height={h} fill={s.color} rx={1.5}><title>{`${label} — ${s.name}: ${v}`}</title></rect>;
              })}
              {named(i) && (
                <text x={x0} y={height - 9} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <figcaption className="legend" style={{ marginTop: 6 }}>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

export function HBars({ rows, title, max: fixedMax, suffix = '' }: { rows: { label: string; value: number; tone?: 'ok' | 'warn' | 'danger' }[]; title: string; max?: number; suffix?: string }) {
  const max = fixedMax ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="stack" role="img" aria-label={title} style={{ gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label} className="stack" style={{ gap: 4 }}>
          <div className="row between small">
            <span>{r.label}</span>
            <strong>
              {r.value}
              {suffix}
            </strong>
          </div>
          <div className={`meter ${r.tone ?? ''}`}>
            <span style={{ width: `${Math.min(100, (r.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
