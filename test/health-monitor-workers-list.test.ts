import { describe, it, expect, afterEach } from "vitest";
import { registerHealthMonitor } from "../src/health/monitor.js";

// Calling engine::workers::list on engine 0.22.1 drops the calling worker's
// connection: reproduced 2 of 2 off-cycle with a clean control window, and
// the monitor did it every 30 s, unregistering every route each time. The
// worker list is informational only, so it is opt-in.

const ENV = "AGENTMEMORY_HEALTH_LIST_WORKERS";

function harness() {
  const triggered: string[] = [];
  const store = new Map<string, unknown>();
  const sdk = {
    trigger: async (req: { function_id: string }) => {
      triggered.push(req.function_id);
      return { workers: [{ id: "w1" }] };
    },
  };
  const kv = {
    get: async (scope: string, key: string) => store.get(`${scope}/${key}`) ?? null,
    set: async (scope: string, key: string, v: unknown) => {
      store.set(`${scope}/${key}`, v);
      return v;
    },
  };
  return { sdk, kv, triggered, store };
}

async function settle(store: Map<string, unknown>) {
  for (let i = 0; i < 50 && !store.has("mem:health/latest"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("health monitor and engine::workers::list", () => {
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  it("does not call engine::workers::list by default, and still writes a snapshot", async () => {
    delete process.env[ENV];
    const h = harness();
    const mon = registerHealthMonitor(h.sdk as never, h.kv as never);
    await settle(h.store);
    mon.stop();
    expect(h.store.has("mem:health/latest")).toBe(true);
    expect(h.triggered).not.toContain("engine::workers::list");
    expect((h.store.get("mem:health/latest") as { workers: unknown[] }).workers).toEqual([]);
  });

  it("control: calls it when opted in", async () => {
    process.env[ENV] = "true";
    const h = harness();
    const mon = registerHealthMonitor(h.sdk as never, h.kv as never);
    await settle(h.store);
    mon.stop();
    expect(h.triggered).toContain("engine::workers::list");
    expect((h.store.get("mem:health/latest") as { workers: unknown[] }).workers).toEqual([{ id: "w1" }]);
  });
});
