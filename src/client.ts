/**
 * Client for the Xpo Feedback Center. Works in browsers and Node 18+ (uses fetch).
 *
 * User-facing calls (sendFeedback, requestSupport, getKeyInfo) reject with a
 * FeedbackError so your UI can react. Telemetry (captureException,
 * captureMessage, track) never throws: reporting must never break your app.
 */

const SDK = "xpo-feedback-js/0.1.0";

export type ErrorLevel = "fatal" | "error" | "warning" | "info";

export interface User {
  id?: string;
  email?: string;
  name?: string;
}

export interface Breadcrumb {
  message: string;
  category?: string;
  level?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface KeyInfo {
  key_id: string;
  application: string;
  application_name: string;
  customer: string | null;
  kind: "public" | "protected";
  capabilities: string[];
}

export interface FeedbackClientOptions {
  /** The software key issued in the Feedback Center dashboard. */
  key: string;
  /** Base URL of the Feedback Center ingestion API, e.g. https://feedback.xpo.example */
  baseUrl: string;
  /** Your application version; sent with every report. */
  release?: string;
  environment?: string;
  /** Extra context sent with every report. */
  context?: Record<string, unknown>;
  timeoutMs?: number;
  retries?: number;
  maxBreadcrumbs?: number;
  /** Analytics events are sent when this many are queued… */
  batchSize?: number;
  /** …or after this long, whichever comes first. */
  flushIntervalMs?: number;
  /** Stable anonymous id for analytics; generated (and remembered in browsers) if omitted. */
  anonymousId?: string;
  /** Custom fetch implementation (tests, older runtimes). */
  fetch?: typeof fetch;
}

export interface FeedbackInput {
  message: string;
  category?: string;
  /** 1–5 */
  rating?: number;
  user?: User;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SupportInput {
  subject: string;
  message: string;
  category?: string;
  user?: User;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CaptureOptions {
  level?: ErrorLevel;
  /** Group reports by this key instead of by stack trace. */
  fingerprint?: string;
  user?: User;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface QueuedEvent {
  name: string;
  timestamp: string;
  anonymous_id: string;
  session_id: string;
  user_id?: string;
  properties: Record<string, unknown>;
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function storedAnonymousId(): string {
  const KEY = "xpo-feedback-anonymous-id";
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const id = randomId();
    window.localStorage.setItem(KEY, id);
    return id;
  } catch {
    return randomId();
  }
}

function defaultContext(): Record<string, unknown> {
  if (isBrowser) {
    return {
      platform: "web",
      url: window.location?.href,
      locale: navigator.language,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      sdk: SDK,
    };
  }
  const proc = (globalThis as { process?: { platform?: string; version?: string } }).process;
  return { platform: proc?.platform, runtime: proc?.version ? `node ${proc.version}` : undefined, sdk: SDK };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeError(error: unknown): { type?: string; message: string; stacktrace?: string } {
  if (error instanceof Error) {
    return { type: error.name || error.constructor?.name, message: error.message, stacktrace: error.stack };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

export class FeedbackClient {
  readonly baseUrl: string;
  readonly anonymousId: string;
  readonly sessionId = randomId();
  private readonly key: string;
  private readonly opts: Required<Pick<FeedbackClientOptions, "timeoutMs" | "retries" | "maxBreadcrumbs" | "batchSize" | "flushIntervalMs">>;
  private readonly fetchImpl: typeof fetch;
  private context: Record<string, unknown>;
  private user: User | undefined;
  private breadcrumbs: Breadcrumb[] = [];
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: FeedbackClientOptions) {
    if (!options.key) throw new Error("A software key is required");
    this.key = options.key;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.opts = {
      timeoutMs: options.timeoutMs ?? 5000,
      retries: options.retries ?? 2,
      maxBreadcrumbs: options.maxBreadcrumbs ?? 50,
      batchSize: Math.min(100, Math.max(1, options.batchSize ?? 20)),
      flushIntervalMs: options.flushIntervalMs ?? 10_000,
    };
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("fetch is not available; pass options.fetch");
    this.fetchImpl = f.bind(globalThis);
    this.anonymousId = options.anonymousId ?? (isBrowser ? storedAnonymousId() : randomId());
    this.context = {
      ...defaultContext(),
      ...(options.release ? { app_version: options.release } : {}),
      ...options.context,
    };
    if (isBrowser) {
      // Send queued analytics when the page is hidden or closed.
      window.addEventListener("pagehide", () => void this.flush({ keepalive: true }));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.flush({ keepalive: true });
      });
    }
  }

  // ------------------------------------------------------------------ transport

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, keepalive = false): Promise<T> {
    let attempt = 0;
    for (;;) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
      const timeout = controller ? setTimeout(() => controller.abort(), this.opts.timeoutMs) : undefined;
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.key}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller?.signal,
          keepalive,
        });
        if (res.ok) {
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= this.opts.retries) {
          let detail: unknown;
          try {
            detail = ((await res.json()) as { detail?: unknown }).detail;
          } catch {
            /* not JSON */
          }
          const text = Array.isArray(detail)
            ? detail.map((d: { msg?: string }) => d?.msg ?? String(d)).join("; ")
            : (detail as string | undefined);
          throw new FeedbackError(`${res.status}: ${text ?? res.statusText}`, res.status);
        }
      } catch (err) {
        if (err instanceof FeedbackError) throw err;
        if (attempt >= this.opts.retries) {
          throw new FeedbackError(`Feedback Center unreachable: ${(err as Error)?.message ?? err}`);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      attempt++;
      await sleep(Math.min(4000, 500 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));
    }
  }

  private mergeContext(extra?: Record<string, unknown>): Record<string, unknown> {
    return { ...this.context, ...extra };
  }

  // ------------------------------------------------------------------ identity

  /** Attach an end user to everything sent afterwards. Pass null to clear. */
  setUser(user: User | null): void {
    this.user = user ?? undefined;
  }

  /** Add or override context sent with every report. */
  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  /** What may this key do? Useful to hide UI for capabilities the key lacks. */
  getKeyInfo(): Promise<KeyInfo> {
    return this.request<KeyInfo>("GET", "/key");
  }

  // ------------------------------------------------------------------ feedback & support

  /** Send end-user feedback. Resolves with the ticket id. */
  async sendFeedback(input: FeedbackInput): Promise<{ id: string }> {
    return this.request("POST", "/feedback", {
      message: input.message,
      category: input.category,
      rating: input.rating,
      user: input.user ?? this.user,
      context: this.mergeContext(input.context),
      metadata: input.metadata ?? {},
    });
  }

  /** Open a support request. Include the user's email so Xpo can reply. */
  async requestSupport(input: SupportInput): Promise<{ id: string }> {
    return this.request("POST", "/support", {
      subject: input.subject,
      message: input.message,
      category: input.category,
      user: input.user ?? this.user,
      context: this.mergeContext(input.context),
      metadata: input.metadata ?? {},
    });
  }

  // ------------------------------------------------------------------ errors

  /** Record something that happened; the latest ones are sent with the next error. */
  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.push({ ...crumb, message: String(crumb.message).slice(0, 2000), timestamp: crumb.timestamp ?? new Date().toISOString() });
    if (this.breadcrumbs.length > this.opts.maxBreadcrumbs) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - this.opts.maxBreadcrumbs);
    }
  }

  /** Report an error. Never throws; resolves with the event id, or undefined on failure. */
  captureException(error: unknown, options: CaptureOptions = {}): Promise<string | undefined> {
    const { type, message, stacktrace } = describeError(error);
    return this.sendError({ type, message, stacktrace, level: options.level ?? "error" }, options);
  }

  /** Report a notable condition that isn't an exception. Never throws. */
  captureMessage(message: string, options: CaptureOptions = {}): Promise<string | undefined> {
    return this.sendError({ message, level: options.level ?? "info" }, options);
  }

  private async sendError(payload: Record<string, unknown>, options: CaptureOptions): Promise<string | undefined> {
    try {
      const res = await this.request<{ id: string }>("POST", "/errors", {
        ...payload,
        fingerprint: options.fingerprint,
        release: this.options.release,
        environment: this.options.environment,
        timestamp: new Date().toISOString(),
        breadcrumbs: [...this.breadcrumbs],
        user: options.user ?? this.user,
        context: this.mergeContext(options.context),
        metadata: options.metadata ?? {},
      });
      return res.id;
    } catch (err) {
      if (typeof console !== "undefined") console.warn("[xpo-feedback] could not report error:", (err as Error).message);
      return undefined;
    }
  }

  /**
   * Report uncaught errors and unhandled promise rejections.
   * Browser: window "error"/"unhandledrejection". Node: process events.
   * Returns a function that removes the handlers.
   */
  installGlobalHandlers(): () => void {
    if (isBrowser) {
      const onError = (e: ErrorEvent) => void this.captureException(e.error ?? e.message, { level: "fatal" });
      const onRejection = (e: PromiseRejectionEvent) => void this.captureException(e.reason, { level: "error" });
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      return () => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      };
    }
    const proc = (globalThis as { process?: NodeJS.Process }).process;
    if (!proc?.on) return () => {};
    // "uncaughtExceptionMonitor" observes without changing Node's crash behaviour.
    const onException = (err: Error) => void this.captureException(err, { level: "fatal" });
    const onRejection = (reason: unknown) => void this.captureException(reason, { level: "error" });
    proc.on("uncaughtExceptionMonitor", onException);
    proc.on("unhandledRejection", onRejection);
    return () => {
      proc.off("uncaughtExceptionMonitor", onException);
      proc.off("unhandledRejection", onRejection);
    };
  }

  // ------------------------------------------------------------------ analytics

  /** Queue an analytics event. Events are sent in batches. */
  track(name: string, properties: Record<string, unknown> = {}, options: { userId?: string } = {}): void {
    if (this.closed) return;
    this.queue.push({
      name,
      timestamp: new Date().toISOString(),
      anonymous_id: this.anonymousId,
      session_id: this.sessionId,
      user_id: options.userId ?? this.user?.id,
      properties,
    });
    if (this.queue.length > 10_000) this.queue.splice(0, this.queue.length - 10_000);
    if (this.queue.length >= this.opts.batchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.opts.flushIntervalMs);
      // Don't keep a Node process alive just for analytics.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Send all queued analytics events now. Never throws. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    // A flush in progress drains the whole queue (including events added meanwhile).
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 100);
        try {
          await this.request("POST", "/events", { events: batch, context: this.context }, options.keepalive);
        } catch (err) {
          const status = err instanceof FeedbackError ? err.status : undefined;
          if (status !== undefined && status >= 400 && status < 500 && status !== 429) continue; // drop bad batch
          this.queue.unshift(...batch); // keep for later
          return;
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Flush pending analytics and stop accepting new events. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
