# Changelog

## 0.1.0

First release.

- `FeedbackClient` with `sendFeedback`, `requestSupport`, `captureException`,
  `captureMessage`, `addBreadcrumb`, `track`, `getKeyInfo`, `installGlobalHandlers`
- Browsers and Node 18+, no dependencies, ESM with TypeScript types
- In browsers, reports carry the current page URL and queued analytics are sent
  when the page is hidden
