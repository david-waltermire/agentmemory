import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { SAFE_PAYLOAD_BYTES } from "../src/state/frame-guard.js";

// GET /semantic and /procedural returned the whole scope in one response.
// A 23 MB semantic scope crossed the engine's 16 MiB frame limit, dropping
// the worker (every route 404s) on each 30 s viewer dashboard poll. Both
// now return one page plus the total, and refuse an oversized page as 413.

/** In-memory StateKV: one Map per scope; get, update and delete are no-ops. */
function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async () => null,
    set: async <T>(s: string, k: string, d: T) => {
      if (!store.has(s)) store.set(s, new Map());
      store.get(s)!.set(k, d);
      return d;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

/** SDK stub that records registered functions so a handler can be called directly. */
function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

type Res = { status_code: number; body: Record<string, unknown> };

/** Seeds `n` records of `bytesEach` bytes into `scope` and registers the API handlers. */
async function setup(scope: string, n: number, bytesEach = 20) {
  const kv = mockKV();
  for (let i = 0; i < n; i++) {
    await kv.set(scope, `id_${i}`, {
      id: `id_${i}`,
      fact: "f".repeat(bytesEach),
    });
  }
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never);
  return sdk;
}

/** Invokes a registered handler with the given query parameters. */
const call = (
  sdk: ReturnType<typeof mockSdk>,
  fn: string,
  q: Record<string, string> = {},
) => sdk._fns.get(fn)!({ headers: {}, query_params: q }) as Promise<Res>;

const CASES = [
  { fn: "api::semantic-list", scope: KV.semantic, key: "semantic" },
  { fn: "api::procedural-list", scope: KV.procedural, key: "procedural" },
] as const;

for (const c of CASES) {
  describe(`${c.fn} pagination`, () => {
    it("returns a default page of 50 plus the total and a cursor", async () => {
      const sdk = await setup(c.scope, 120);
      const r = await call(sdk, c.fn);
      expect(r.status_code).toBe(200);
      expect((r.body[c.key] as unknown[]).length).toBe(50);
      expect(r.body.total).toBe(120);
      expect(typeof r.body.nextCursor).toBe("string");
    });

    it("walks every record by following nextCursor", async () => {
      const sdk = await setup(c.scope, 12);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const q: Record<string, string> = { limit: "5" };
        if (cursor) q.cursor = cursor;
        const r = await call(sdk, c.fn, q);
        seen.push(...(r.body[c.key] as Array<{ id: string }>).map((x) => x.id));
        cursor = r.body.nextCursor as string | null;
        if (!cursor) break;
      }
      expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => `id_${i}`));
    });

    it("caps limit at 500", async () => {
      const sdk = await setup(c.scope, 600);
      const r = await call(sdk, c.fn, { limit: "100000" });
      expect((r.body[c.key] as unknown[]).length).toBe(500);
    });

    it("falls back to the default page for a limit that is not a number", async () => {
      // parseInt would read "5abc" as 5; the shared list-query parser rejects it.
      const sdk = await setup(c.scope, 60);
      for (const limit of ["5abc", "abc", "0", "-3", ""]) {
        const r = await call(sdk, c.fn, { limit });
        expect(
          (r.body[c.key] as unknown[]).length,
          `limit=${JSON.stringify(limit)}`,
        ).toBe(50);
      }
    });

    it("the last page has no nextCursor", async () => {
      const sdk = await setup(c.scope, 3);
      const r = await call(sdk, c.fn, { limit: "5" });
      expect((r.body[c.key] as unknown[]).length).toBe(3);
      expect(r.body.nextCursor).toBeNull();
    });

    it("refuses a page over the frame limit with 413 instead of sending it", async () => {
      const each = Math.ceil(SAFE_PAYLOAD_BYTES / 40) + 1024;
      const sdk = await setup(c.scope, 50, each);
      const r = await call(sdk, c.fn);
      expect(r.status_code).toBe(413);
      expect(r.body).toMatchObject({ oversized: true });
      expect(JSON.stringify(r.body).length).toBeLessThan(10_000);
    });
  });
}

describe("viewer asks for a page, not the whole scope", () => {
  const html = readFileSync("src/viewer/index.html", "utf-8");
  it("requests semantic and procedural with a limit", () => {
    expect(html).toMatch(/semantic: \{ path: 'semantic\?limit=\d+'/);
    expect(html).toMatch(/procedural: \{ path: 'procedural\?limit=\d+'/);
    expect(html).not.toMatch(/path: 'semantic'/);
    expect(html).not.toMatch(/path: 'procedural'/);
  });
});
