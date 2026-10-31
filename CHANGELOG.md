# Changelog

## Unreleased fixes

- Create the status-strip focus handle during initialization. Dashboard and
  pane controls use native buttons with retained focus, so rendering never
  creates view-owned focus handles. Regression tests enforce Herdr's phase rule.

## 0.1.0 — local trial, native validation pending

- Compact quota strip with graphical dashboard and a configurable 70% redline.
- Installed-agent discovery and live status/navigation across Herdr spaces.
- Codex, Claude and Grok preferred by default; running agents promoted first.
- Account-separated quota windows, reset times, pace and explicit data states.
- Persistent provider, kind and individual-window visibility settings.
- Optional quota-aware pane headers.
- Shared collector lease, bounded refresh frequency and failure backoff.
- Clone-based installer, setup plan, synthetic preview and regression suite.

Local setup has completed, including the installer's native checks. Initial
live visual inspection covered the strip, pane header, dashboard and Configure.
A transient dashboard render interruption remains open; closing and reopening
restored the view. Claude quota currently requires authentication. Remote account
collection and token-count telemetry are not implemented. No public repository
or release has been published. See VALIDATION.md for evidence and remaining checks.
