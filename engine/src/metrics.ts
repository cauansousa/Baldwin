/** Minimal Prometheus text-format metrics: counters, callback gauges, one histogram type. */

type Labels = Record<string, string>;

const labelStr = (l: Labels) => {
  const keys = Object.keys(l);
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${String(l[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",")}}`;
};

export type GaugeValue = number | null | { labels: Labels; value: number }[];

interface Counter {
  help: string;
  values: Map<string, number>;
}

interface Histogram {
  help: string;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, { help: string; read: () => GaugeValue }>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(private readonly prefix = "foxy_") {}

  /** Declare a counter so that it is exported (as 0) before its first increment. */
  counter(name: string, help: string): void {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() });
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help: name, values: new Map() }));
    const key = labelStr(labels);
    c.values.set(key, (c.values.get(key) ?? 0) + by);
  }

  /** Value of a counter (summed over labels); for tests and /health. */
  get(name: string): number {
    let total = 0;
    for (const v of this.counters.get(name)?.values.values() ?? []) total += v;
    return total;
  }

  /**
   * A gauge read at scrape time. Return a number, null to omit it, or a list of
   * labelled samples.
   */
  gauge(name: string, help: string, read: () => GaugeValue): void {
    this.gauges.set(name, { help, read });
  }

  histogram(name: string, help: string, buckets: number[]): void {
    this.histograms.set(name, { help, buckets, counts: buckets.map(() => 0), sum: 0, count: 0 });
  }

  observe(name: string, value: number): void {
    const h = this.histograms.get(name);
    if (!h) return;
    h.sum += value;
    h.count++;
    h.buckets.forEach((b, i) => {
      if (value <= b) h.counts[i]!++;
    });
  }

  render(): string {
    const out: string[] = [];
    for (const [name, c] of this.counters) {
      const n = this.prefix + name;
      out.push(`# HELP ${n} ${c.help}`, `# TYPE ${n} counter`);
      if (c.values.size === 0) out.push(`${n} 0`);
      for (const [labels, v] of c.values) out.push(`${n}${labels} ${v}`);
    }
    for (const [name, g] of this.gauges) {
      let v: GaugeValue = null;
      try {
        v = g.read();
      } catch {
        v = null;
      }
      const samples = (Array.isArray(v) ? v : v === null ? [] : [{ labels: {}, value: v }]).filter((x) => Number.isFinite(x.value));
      if (samples.length === 0) continue;
      const n = this.prefix + name;
      out.push(`# HELP ${n} ${g.help}`, `# TYPE ${n} gauge`);
      for (const x of samples) out.push(`${n}${labelStr(x.labels)} ${x.value}`);
    }
    for (const [name, h] of this.histograms) {
      const n = this.prefix + name;
      out.push(`# HELP ${n} ${h.help}`, `# TYPE ${n} histogram`);
      h.buckets.forEach((b, i) => out.push(`${n}_bucket{le="${b}"} ${h.counts[i]}`));
      out.push(`${n}_bucket{le="+Inf"} ${h.count}`, `${n}_sum ${h.sum}`, `${n}_count ${h.count}`);
    }
    return out.join("\n") + "\n";
  }
}
