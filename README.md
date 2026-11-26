# @xpo/feedback: TypeScript/JavaScript client for the Xpo Feedback Center

Send **feedback**, **support requests**, **crash/error reports** and **usage analytics**
from Xpo software to the Xpo Feedback Center.

- Browsers and Node 18+ (anything with `fetch`); no dependencies
- ES module with TypeScript types
- Error reporting never throws, so it can't break your application
- Works with any text, including Hebrew and other non-Latin scripts

> Python? See [fbc-client-py](https://github.com/xpodev/fbc-client-py).

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Keys: public or protected](#keys-public-or-protected)
- [Configuration](#configuration)
- [The end user](#the-end-user)
- [Feedback](#feedback)
- [Support requests](#support-requests)
- [Errors and crashes](#errors-and-crashes)
- [Analytics](#analytics)
- [Checking what a key can do](#checking-what-a-key-can-do)
- [Error handling](#error-handling)
- [Recipes](#recipes)
- [Limits](#limits)
- [API reference](#api-reference)
- [Versioning](#versioning)
- [Development](#development)

## Installation

Install straight from this repository, pinned to a release tag (needs `git` on the
machine):

```bash
npm install github:xpodev/fbc-client-ts#v0.1.0
# or
pnpm add github:xpodev/fbc-client-ts#v0.1.0
yarn add github:xpodev/fbc-client-ts#v0.1.0
```

This adds `"@xpo/feedback": "github:xpodev/fbc-client-ts#v0.1.0"` to your
`package.json`. The package manager builds it on install (its `prepare` script runs
`tsc`), so the first install takes a few extra seconds.

```ts
import { FeedbackClient } from "@xpo/feedback";
```

The package is ESM-only. Bundlers (Vite, webpack, esbuild, Next.js) and Node's
`import` handle it. From CommonJS on Node 18 or 20, use
`const { FeedbackClient } = await import("@xpo/feedback")`; Node 22.12+ can also
`require()` it.

## Quick start

```ts
import { FeedbackClient } from "@xpo/feedback";

export const feedback = new FeedbackClient({
  key: "<software key from the Feedback Center dashboard>",
  baseUrl: "https://feedback.xpo.example",
  release: "3.2.1",          // your application's version
  environment: "production",
});

feedback.installGlobalHandlers();                        // report uncaught errors
await feedback.sendFeedback({ message: "Love the new export!", rating: 5 });
feedback.track("report_exported", { format: "xlsx" });
```

Create **one client** for the app (for example in its own module, as above) and import
it wherever you need it. It holds the breadcrumb buffer and the analytics queue.

## Keys: public or protected

Each key is created in the Feedback Center dashboard for one piece of software
(optionally for one customer) and comes in two kinds:

| | Public key | Protected key |
|---|---|---|
| Use it in | Browser, desktop (Electron) and mobile apps | Node servers that Xpo or the customer control |
| Secret? | No. Anyone can read it from your bundle | Yes. Load it from an environment variable or secret store |
| Shown in the dashboard as | **Public** (unverified sender) | **Verified** |
| Rate limit | 60 requests/min per key **and** client IP | 1200 requests/min per key |
| Extras | Can be restricted to specific website origins | n/a |

**Never put a protected key in browser code.** If a web app needs verified reports,
forward them through your server (see [Recipes](#forwarding-reports-from-your-server)).

A key also has a fixed set of **capabilities**: `feedback`, `support`, `errors` and
`analytics`. Calling a method the key isn't allowed to use fails with HTTP 403 (see
[Error handling](#error-handling)). Use [`getKeyInfo()`](#checking-what-a-key-can-do)
to find out what a key can do.

## Configuration

```ts
new FeedbackClient({
  key: string,                 // required
  baseUrl: string,             // required: e.g. "https://feedback.xpo.example"
  release?: string,            // your app version; sent with errors and as context.app_version
  environment?: string,        // e.g. "production", "staging"; sent with errors
  context?: Record<string, unknown>, // merged into the context of every report
  timeoutMs?: number,          // per HTTP attempt (default 5000)
  retries?: number,            // extra attempts on network errors, 429 and 5xx (default 2)
  maxBreadcrumbs?: number,     // breadcrumbs kept for the next error report (default 50)
  batchSize?: number,          // send analytics when this many are queued (default 20, max 100)
  flushIntervalMs?: number,    // ...or after this long (default 10000)
  anonymousId?: string,        // stable id for analytics (see below)
  fetch?: typeof fetch,        // custom fetch, e.g. for tests or older runtimes
});
```

**Context** is free-form information about where a report came from, shown in the
dashboard next to each report. The client fills in some of it automatically:

| | Automatic context |
|---|---|
| Browser | `platform: "web"`, `url` (the page URL at the time of the report), `locale`, `screen`, `sdk` |
| Node | `platform` (`linux`, `win32`, …), `runtime` (Node version), `sdk` |

`app_version` is added when you pass `release`. Add your own with the `context` option,
`setContext()`, or the `context` field of any single call (merged on top). The server
also records the `User-Agent` and `Origin` headers.

**Retries** wait about 0.5 s, then 1 s, doubling up to 4 s, with some jitter. They
apply only to network errors, HTTP 429 and HTTP 5xx; other errors are not retried.

## The end user

Attach the person using your software to everything sent afterwards:

```ts
feedback.setUser({ id: "42", email: "dana@acme.example", name: "Dana Cohen" });
feedback.setUser(null);   // clear it, e.g. on sign-out
```

Or pass `user` to a single call. All fields are optional. With a public key the
dashboard labels this information *self-reported*: it's whatever your code sent, and
nobody verified it.

## Feedback

```ts
const { id } = await feedback.sendFeedback({
  message: "Exporting to Excel takes almost a minute",
  category: "bug",          // free text, max 64 chars, e.g. "bug", "idea", "praise"
  rating: 3,                // optional 1–5
  metadata: { screen: "reports", rows: 5200 },
});
```

Resolves with the new ticket's id. Rejects with `FeedbackError` on failure, so you can
tell the user (see [Error handling](#error-handling)).

## Support requests

```ts
await feedback.requestSupport({
  subject: "Can't sign in",
  message: "After resetting my password the login page says the password is wrong.",
  user: { name: "Dana Cohen", email: "dana@acme.example" },   // how Xpo can reply
  category: "login",
});
```

Support requests show up in the dashboard's **Support** inbox. Include a way to
contact the user, or Xpo won't be able to answer. Resolves with `{ id }`; rejects with
`FeedbackError` on failure.

## Errors and crashes

### Uncaught errors

```ts
const uninstall = feedback.installGlobalHandlers();
```

- **Browser:** listens to the window's `error` event (reported as `fatal`) and
  `unhandledrejection` (reported as `error`).
- **Node:** listens to `uncaughtExceptionMonitor` (reported as `fatal`) and
  `unhandledRejection` (reported as `error`). It only observes; Node's normal
  behaviour is unchanged.

The returned function removes the handlers.

In Node, an uncaught exception normally ends the process **immediately**, before the
report has been sent. To make sure crashes arrive, handle them yourself and exit after
reporting:

```ts
process.on("uncaughtException", async (err) => {
  await feedback.captureException(err, { level: "fatal" });
  process.exit(1);
});
```

### Handled errors

```ts
try {
  await importOrders(file);
} catch (err) {
  await feedback.captureException(err, { metadata: { file: file.name } });
  throw err;   // or handle it however you like
}
```

`captureException` accepts anything that was thrown. For `Error` objects it sends the
name, message and stack; other values are sent as their JSON text. Reports include
`release`, `environment`, the current user, context and recent breadcrumbs.

You don't have to `await` it; the returned promise never rejects.

### Messages

For notable conditions that aren't exceptions:

```ts
feedback.captureMessage("Disk almost full", { level: "warning", metadata: { freeMb: 120 } });
```

Levels: `"fatal"`, `"error"`, `"warning"`, `"info"`.

### Grouping

The dashboard groups reports of the same problem into one **issue**. By default the
grouping key comes from the error type and stack trace; line and column numbers,
numeric ids and hex addresses are ignored, so the same bug in a later release still
lands in the same issue. To group differently, pass your own `fingerprint`:

```ts
feedback.captureException(err, { fingerprint: "payment-gateway-timeout" });
```

If an issue was marked *resolved* and happens again, it reopens automatically.

> Minified browser bundles produce stack traces with minified names. Groups still
> work, but publishing source maps alongside your bundle makes traces readable for
> anyone who opens the files.

### Breadcrumbs

Breadcrumbs are a short trail of what happened before an error. The most recent
ones (50 by default) are attached to the next error report:

```ts
feedback.addBreadcrumb({ message: "Opened order 1042", category: "navigation" });
feedback.addBreadcrumb({ message: "GET /api/stock -> 503", category: "http", level: "warning", data: { ms: 3100 } });
```

## Analytics

```ts
feedback.track("report_exported", { format: "xlsx", rows: 5200 });
feedback.track("item_scanned", {}, { userId: "42" });   // overrides the current user's id
```

`track()` queues the event and returns immediately. Queued events are sent when
`batchSize` events are waiting or `flushIntervalMs` has passed. Each event carries an
`anonymousId` and a `sessionId`, so the dashboard can count unique users even without a
user id.

- **Browser:** the anonymous id is stored in `localStorage`
  (`xpo-feedback-anonymous-id`), so a returning visitor keeps the same id. Queued
  events are also sent when the page is hidden or closed.
- **Node:** the anonymous id is random per client unless you pass `anonymousId`. The
  flush timer doesn't keep the process alive, so call `await feedback.close()` before a
  short-lived script exits.
- `await feedback.flush()` sends everything queued, now.
- `await feedback.close()` flushes and stops accepting new events.
- If the server is unreachable, events stay queued (up to 10,000; oldest dropped
  first) and are retried on the next flush. A batch the server rejects outright (for
  example, the key lacks `analytics`) is dropped.

## Checking what a key can do

```ts
const info = await feedback.getKeyInfo();
// { key_id, application: "inventory-pro", application_name: "Inventory Pro",
//   customer: "Acme Ltd" | null, kind: "public" | "protected",
//   capabilities: ["errors", "feedback"] }

const showSupportButton = info.capabilities.includes("support");
```

Rejects with `FeedbackError` on failure (for example, 401 for a revoked key).

## Error handling

| Method | On failure |
|---|---|
| `sendFeedback`, `requestSupport`, `getKeyInfo` | Reject with `FeedbackError` |
| `captureException`, `captureMessage` | Resolve with `undefined` and `console.warn` |
| `track`, `flush`, `close` | Never throw; events are kept for retry or dropped, as described above |

`FeedbackError` has a readable `message` and `status`, the HTTP status code (`undefined`
when the server couldn't be reached):

```ts
import { FeedbackError } from "@xpo/feedback";

try {
  await feedback.sendFeedback({ message, rating });
} catch (err) {
  if (err instanceof FeedbackError && err.status === 429) {
    toast("Too many messages, please try again in a minute.");
  } else if (err instanceof FeedbackError && err.status === undefined) {
    toast("Can't reach the server. Check your connection.");
  } else {
    toast("Sending failed. Please try again later.");
  }
}
```

| Status | Meaning |
|---|---|
| 401 | Missing, invalid or revoked key |
| 403 | The key lacks the capability, or this website's origin isn't allowed for the key |
| 413 | The request body is too large |
| 422 | Invalid input (for example, an empty message or a rating outside 1–5); the message says which field |
| 429 | Rate limited |
| 5xx | Server problem (already retried) |

## Recipes

### React feedback form

```tsx
import { useState } from "react";
import { FeedbackError } from "@xpo/feedback";
import { feedback } from "./feedback";   // your shared client

export function FeedbackForm() {
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState<number>();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      await feedback.sendFeedback({ message, rating });
      setState("sent");
    } catch (err) {
      console.error(err instanceof FeedbackError ? err.message : err);
      setState("error");
    }
  }

  if (state === "sent") return <p>Thanks for your feedback!</p>;
  return (
    <form onSubmit={submit}>
      <textarea dir="auto" value={message} onChange={(e) => setMessage(e.target.value)} required />
      <select value={rating ?? ""} onChange={(e) => setRating(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">No rating</option>
        {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}
      </select>
      <button disabled={state === "sending"}>Send</button>
      {state === "error" && <p role="alert">Couldn't send. Please try again.</p>}
    </form>
  );
}
```

`dir="auto"` lets users type Hebrew or English naturally.

### React error boundary

```tsx
import { Component, type ReactNode } from "react";
import { feedback } from "./feedback";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    feedback.captureException(error, { level: "fatal", metadata: { componentStack: info.componentStack } });
  }
  render() {
    return this.state.failed ? <p>Something went wrong.</p> : this.props.children;
  }
}
```

### Express

```ts
import express from "express";

const app = express();
// ... routes ...

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  feedback.captureException(err, { context: { path: req.path, method: req.method } });
  next(err);
});
```

### Breadcrumbs from your router or API layer

```ts
router.afterEach((to) => feedback.addBreadcrumb({ message: to.fullPath, category: "navigation" }));

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  feedback.addBreadcrumb({ message: `${init?.method ?? "GET"} ${path} -> ${res.status}`, category: "http" });
  return res;
}
```

### Forwarding reports from your server

Browser code can use a public key directly. To get **verified** reports instead,
have the browser post to your own backend and forward them with a protected key.
Because the user comes from your session, it's trustworthy too:

```ts
// server.ts (Node), with the protected key from the environment
const feedback = new FeedbackClient({ key: process.env.XPO_FEEDBACK_KEY!, baseUrl: process.env.XPO_FEEDBACK_URL! });

app.post("/api/feedback", requireLogin, async (req, res) => {
  await feedback.sendFeedback({
    message: req.body.message,
    rating: req.body.rating,
    user: { id: String(req.user.id), email: req.user.email, name: req.user.name },
  });
  res.sendStatus(204);
});
```

### Restricting a public key to your website

In the dashboard, add your site's origin (for example `https://app.acme.example`) to the
key's **allowed origins**. Browsers sending from any other origin get HTTP 403. This
stops other websites from using the key from their pages. It doesn't stop scripts or
servers, which can send any `Origin` header.

### Hebrew and other languages

All text is sent as UTF-8 and stored as-is. The dashboard shows mixed Hebrew/English
content in the right direction, and search works in any language:

```ts
await feedback.sendFeedback({ message: "הייצוא לאקסל איטי מאוד", category: "באג", rating: 3 });
```

## Limits

Enforced by the server; values over a limit are rejected with HTTP 422.

| Field | Limit |
|---|---|
| Feedback `message` | 10,000 characters |
| Support `subject` / `message` | 255 / 20,000 characters |
| `category` | 64 characters |
| `rating` | Integer 1–5 |
| Error `message` / stack trace | 10,000 / 200,000 characters |
| Breadcrumbs per report | 200 (the client keeps 50 by default) |
| Breadcrumb message | 2,000 characters (the client truncates longer ones) |
| Events per batch / event name | 100 / 128 characters |
| Request body | 512 KB (default server setting) |

Error and event timestamps more than 10 minutes in the future or 30 days in the past
are replaced with the time the server received them.

## API reference

### `new FeedbackClient(options)`

See [Configuration](#configuration) for the options.

**Properties:** `baseUrl`, `anonymousId`, `sessionId` (random per client); all read-only.

| Method | Returns | Notes |
|---|---|---|
| `setUser(user \| null)` | `void` | `null` clears the user |
| `setContext(context)` | `void` | Merged into the context of every later report |
| `getKeyInfo()` | `Promise<KeyInfo>` | Rejects with `FeedbackError` |
| `sendFeedback({ message, category?, rating?, user?, context?, metadata? })` | `Promise<{ id: string }>` | Rejects with `FeedbackError` |
| `requestSupport({ subject, message, category?, user?, context?, metadata? })` | `Promise<{ id: string }>` | Rejects with `FeedbackError` |
| `captureException(error, { level?, fingerprint?, user?, context?, metadata? })` | `Promise<string \| undefined>` | Never rejects |
| `captureMessage(message, { level?, fingerprint?, user?, context?, metadata? })` | `Promise<string \| undefined>` | Never rejects |
| `addBreadcrumb({ message, category?, level?, data?, timestamp? })` | `void` | |
| `installGlobalHandlers()` | `() => void` | Returns a function that removes the handlers |
| `track(name, properties?, { userId? })` | `void` | Queued |
| `flush({ keepalive? })` | `Promise<void>` | Never rejects |
| `close()` | `Promise<void>` | Flushes and stops accepting events |

### Types

`FeedbackClientOptions`, `User`, `FeedbackInput`, `SupportInput`, `CaptureOptions`,
`Breadcrumb`, `ErrorLevel` (`"fatal" | "error" | "warning" | "info"`) and `KeyInfo` are
exported for TypeScript users.

### `FeedbackError`

Extends `Error`. `status` is the HTTP status code, or `undefined` if the server couldn't
be reached.

## Versioning

Releases are tagged `vX.Y.Z`; see [CHANGELOG.md](CHANGELOG.md). Always pin a tag when
installing. The client talks to the Feedback Center's `/v1` API, which only changes in
backward-compatible ways, so older clients keep working against newer servers.

## Development

```bash
npm install
npm test            # vitest; uses a fake fetch, no Feedback Center needed
npm run typecheck
npm run build       # emits dist/
```
