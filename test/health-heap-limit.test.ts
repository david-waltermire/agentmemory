import { describe, expect, it } from "vitest";
import v8 from "node:v8";
import { evaluateHealth } from "../src/health/thresholds.js";
import { registerHealthMonitor } from "../src/health/monitor.js";
import type { HealthSnapshot } from "../src/types.js";

// heapTotal is only what V8 has allocated so far; it grows on demand up to
// heap_size_limit (--max-old-space-size). Dividing by heapTotal made a
// healthy worker read 89% "full" and marked the service degraded while it
// used about 4% of its real 10 GB limit.

const MB = 1024 * 1024;
const GB = 1024 * MB;

function snap(memory: HealthSnapshot["memory"]): HealthSnapshot {
  return {
    connectionState: "connected",
    workers: [],
    memory,
    cpu: { userMicros: 0, systemMicros: 0, percent: 1 },
    eventLoopLagMs: 1,
    uptimeSeconds: 60,
    status: "healthy",
    alerts: [],
  } as HealthSnapshot;
}

describe("heap usage is measured against the heap limit", () => {
  it("a heap nearly full of its allocation but far under the limit is healthy", () => {
    const r = evaluateHealth(
      snap({ heapUsed: 414 * MB, heapTotal: 465 * MB, heapLimit: 10 * GB, rss: 812 * MB, external: 0 }),
    );
    expect(r.status).toBe("healthy");
    expect(r.alerts.filter((a) => a.startsWith("memory_"))).toEqual([]);
    expect(r.notes.filter((n) => n.startsWith("memory_"))).toEqual([]);
  });

  it("a heap near the limit is still critical", () => {
    const r = evaluateHealth(
      snap({ heapUsed: 9.8 * GB, heapTotal: 9.9 * GB, heapLimit: 10 * GB, rss: 11 * GB, external: 0 }),
    );
    expect(r.status).toBe("critical");
    expect(r.alerts.some((a) => a.startsWith("memory_critical_98%"))).toBe(true);
  });

  it("a heap at 85% of the limit warns", () => {
    const r = evaluateHealth(
      snap({ heapUsed: 8.5 * GB, heapTotal: 8.6 * GB, heapLimit: 10 * GB, rss: 9 * GB, external: 0 }),
    );
    expect(r.status).toBe("degraded");
    expect(r.alerts.some((a) => a.startsWith("memory_warn_85%"))).toBe(true);
  });

  it("without a heap limit it falls back to heapTotal, as before", () => {
    const r = evaluateHealth(
      snap({ heapUsed: 414 * MB, heapTotal: 465 * MB, rss: 812 * MB, external: 0 }),
    );
    expect(r.alerts.some((a) => a.startsWith("memory_warn_89%"))).toBe(true);
  });

  it("the monitor records V8's heap limit in the snapshot", async () => {
    const store = new Map<string, unknown>();
    const sdk = { trigger: async () => ({}) };
    const kv = {
      get: async (s: string, k: string) => store.get(`${s}/${k}`) ?? null,
      set: async (s: string, k: string, v: unknown) => (store.set(`${s}/${k}`, v), v),
    };
    const mon = registerHealthMonitor(sdk as never, kv as never);
    for (let i = 0; i < 50 && !store.has("mem:health/latest"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    mon.stop();
    const latest = store.get("mem:health/latest") as HealthSnapshot;
    expect(latest.memory.heapLimit).toBe(v8.getHeapStatistics().heap_size_limit);
  });
});
