# @xpo/feedback (TypeScript / JavaScript)

Client for the Xpo Feedback Center. Works in browsers and Node 18+; no dependencies.

Publish it to your npm registry (`npm publish` in `clients/typescript`) and
`npm install @xpo/feedback`, or build a tarball with `npm pack` and install that file.

```ts
import { FeedbackClient, FeedbackError } from "@xpo/feedback";

const feedback = new FeedbackClient({
  key: "<software key>",
  baseUrl: "https://feedback.xpo.example",
  release: "3.2.1",
  environment: "production",
});

feedback.setUser({ id: "42", email: "dana@acme.example", name: "Dana" });

// Feedback & support: reject with FeedbackError so your UI can show a message
try {
  await feedback.sendFeedback({ message: "Exporting is slow", category: "bug", rating: 3 });
  await feedback.requestSupport({ subject: "Can't log in", message: "Reset link doesn't work" });
} catch (err) {
  if (err instanceof FeedbackError) showToast(err.message);
}

// Errors: never throw
feedback.installGlobalHandlers();            // window.onerror + unhandledrejection (or Node process events)
feedback.addBreadcrumb({ message: "Clicked save", category: "ui" });
await feedback.captureException(error);
await feedback.captureMessage("Disk almost full", { level: "warning" });

// Analytics: queued, sent in batches (and on page hide in browsers)
feedback.track("report_exported", { format: "xlsx" });

// What may this key do? e.g. hide the "Contact support" button when not allowed
const { capabilities } = await feedback.getKeyInfo();
```

## Keys

Browser, desktop and mobile apps must use a **public** key: anyone can read it from
the bundle, so the dashboard marks those submissions as *Public*. A **protected**
key belongs only on a server (for example a Node backend that forwards reports),
loaded from a secret store.
