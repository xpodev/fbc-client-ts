import { afterEach, describe, expect, it, vi } from "vitest";

import { FeedbackClient, FeedbackError } from "../src/index.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(responses: Array<{ status: number; body?: unknown }> = []) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses.shift() ?? { status: url.endsWith("/events") ? 202 : 201, body: { id: `id-${calls.length}` } };
    return new Response(next.body !== undefined ? JSON.stringify(next.body) : null, { status: next.status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(f: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof FeedbackClient>[0]> = {}) {
  return new FeedbackClient({
    key: "tok",
    baseUrl: "https://feedback.test/",
    release: "2.0.0",
    environment: "test",
    retries: 1,
    fetch: f.impl,
    flushIntervalMs: 60_000,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FeedbackClient", () => {
  it("sends feedback with user and context", async () => {
    const f = fakeFetch();
    const c = client(f);
    c.setUser({ id: "u1", email: "u@example.com" });
    const res = await c.sendFeedback({ message: "Great", rating: 5, category: "praise" });
    expect(res.id).toBe("id-1");
    const call = f.calls[0];
    expect(call.url).toBe("https://feedback.test/v1/feedback");
    expect(call.headers.Authorization).toBe("Bearer tok");
    expect(call.body).toMatchObject({ message: "Great", rating: 5, user: { id: "u1" } });
    expect(call.body.context.app_version).toBe("2.0.0");
  });

  it("rejects user-facing calls with FeedbackError", async () => {
    const f = fakeFetch([{ status: 403, body: { detail: "This key does not have the 'support' capability" } }]);
    const c = client(f);
    const err = await c.requestSupport({ subject: "s", message: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(FeedbackError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("support");
  });

  it("formats validation errors", async () => {
    const f = fakeFetch([{ status: 422, body: { detail: [{ msg: "rating too big" }] } }]);
    const err = await client(f).sendFeedback({ message: "x", rating: 9 }).catch((e) => e);
    expect(err.message).toBe("422: rating too big");
  });

  it("retries server errors", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = fakeFetch([{ status: 503 }]);
    await client(f).sendFeedback({ message: "x" });
    expect(f.calls).toHaveLength(2);
  });

  it("captures exceptions with breadcrumbs and never throws", async () => {
    const f = fakeFetch();
    const c = client(f);
    c.addBreadcrumb({ message: "clicked save", category: "ui" });
    const id = await c.captureException(new TypeError("x is undefined"), { fingerprint: "save" });
    expect(id).toBe("id-1");
    const body = f.calls[0].body;
    expect(body).toMatchObject({ type: "TypeError", message: "x is undefined", level: "error", fingerprint: "save", release: "2.0.0" });
    expect(body.stacktrace).toContain("TypeError");
    expect(body.breadcrumbs[0].message).toBe("clicked save");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = client({ impl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, calls: [] }, { retries: 0 });
    await expect(broken.captureMessage("hello")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("captures non-Error values", async () => {
    const f = fakeFetch();
    await client(f).captureException({ code: 42 });
    expect(f.calls[0].body.message).toBe('{"code":42}');
  });

  it("limits breadcrumbs", async () => {
    const f = fakeFetch();
    const c = client(f, { maxBreadcrumbs: 2 });
    ["a", "b", "c"].forEach((m) => c.addBreadcrumb({ message: m }));
    await c.captureMessage("x");
    expect(f.calls[0].body.breadcrumbs.map((b: { message: string }) => b.message)).toEqual(["b", "c"]);
  });

  it("batches analytics by size", async () => {
    const f = fakeFetch();
    const c = client(f, { batchSize: 3 });
    c.setUser({ id: "u7" });
    c.track("a");
    c.track("b");
    expect(f.calls).toHaveLength(0);
    c.track("c", { x: 1 });
    await c.flush();
    expect(f.calls).toHaveLength(1);
    const events = f.calls[0].body.events;
    expect(events.map((e: { name: string }) => e.name)).toEqual(["a", "b", "c"]);
    expect(events[0]).toMatchObject({ user_id: "u7", anonymous_id: c.anonymousId, session_id: c.sessionId });
  });

  it("flushes analytics on a timer", async () => {
    vi.useFakeTimers();
    const f = fakeFetch();
    const c = client(f, { flushIntervalMs: 1000 });
    c.track("a");
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.calls).toHaveLength(1);
  });

  it("keeps analytics when the server is down and drops rejected batches", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = fakeFetch([{ status: 503 }, { status: 503 }, { status: 403 }]);
    const c = client(f);
    c.track("a");
    await c.flush();
    await c.flush(); // 403: no analytics capability -> dropped
    expect(f.calls).toHaveLength(3);
    await c.flush();
    expect(f.calls).toHaveLength(3);
  });

  it("close() flushes and stops tracking", async () => {
    const f = fakeFetch();
    const c = client(f);
    c.track("bye");
    await c.close();
    c.track("ignored");
    await c.flush();
    expect(f.calls).toHaveLength(1);
  });

  it("reports unhandled rejections in Node", async () => {
    const f = fakeFetch();
    const c = client(f);
    const uninstall = c.installGlobalHandlers();
    process.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    uninstall();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.calls[0].body).toMatchObject({ type: "Error", message: "boom" });
  });

  it("sends Hebrew content intact", async () => {
    const f = fakeFetch();
    const c = client(f);
    c.setUser({ name: "יעל כהן" });
    await c.sendFeedback({ message: "הייצוא איטי מאוד", category: "באג", metadata: { מסך: "ייצוא" } });
    await c.captureException(new Error("ערך לא חוקי בשדה 'כמות'"));
    c.track("דוח_יוצא", { פורמט: "אקסל" });
    await c.flush();
    expect(f.calls[0].body).toMatchObject({ message: "הייצוא איטי מאוד", category: "באג", user: { name: "יעל כהן" }, metadata: { מסך: "ייצוא" } });
    expect(f.calls[1].body.message).toBe("ערך לא חוקי בשדה 'כמות'");
    expect(f.calls[2].body.events[0]).toMatchObject({ name: "דוח_יוצא", properties: { פורמט: "אקסל" } });
  });

  it("surfaces Hebrew error details from the server", async () => {
    const f = fakeFetch([{ status: 400, body: { detail: "שגיאה בבקשה" } }]);
    const err = await client(f).sendFeedback({ message: "x" }).catch((e) => e);
    expect(err.message).toBe("400: שגיאה בבקשה");
  });
});
