# Herdr Agent Quota

<!-- impeccable:product-schema 1 -->

## Platform

Native desktop Herdr mod, using GPUI JavaScript. No webview.

## Stack

Herdr's shipped gpui-kit and herdr APIs; provider usage is read natively with
Herdr's `fetch`. Node 22.19+ runs only setup and development tooling. No runtime
dependencies.

## Users

An engineer running multiple agents across Herdr spaces. Codex and Claude
are primary, followed by Grok. Intended for eventual sharing with other Herdr users.

## Product Purpose

See quota pressure without leaving work, then inspect all available agent
limits and live activity in a graphical dashboard. The last 30% of a quota
is its redline. Distinguish session, weekly, monthly and model limits.

## Operating Context

Compact status bar opens a graphical view, confirmed by the user. Preserve
Herdr's theme and existing workspace controls. Installed agents should be
discovered and running agents prioritized. A pane header can expose quota
for the agent being used.

## Capabilities and Constraints

Account quota is shared between sessions; do not sum it across spaces.
Quota availability depends on the provider and authentication. A CLI's
presence alone does not prove measurable quota. Do not invent token counts,
percentages, window durations or reset times. Remote agent activity must
remain distinct from local account quota. Collection must be bounded and
avoid inference requests. v1 does not associate arbitrary per-terminal
credentials with a provider account.

## Brand Commitments

Named Herdr Agent Quota. Closely follow Lakris2407/herdr-quota's status-bar
workflow and configuration, with terminal-styled meters and optional gauges.

## Evidence on Hand

Reference: https://github.com/Lakris2407/herdr-quota at commit 832e026.
Provider endpoints and identities: ported from https://github.com/kunchenguid/quota-axi
v0.1.69 (schema 5), kept as a dev dependency for parity tests.
Herdr's installed AGENTS.md and type declarations are implementation authority.

## Product Principles

- Unknown usage stays unknown.
- Quota belongs to an account; activity belongs to sessions and spaces.
- Quiet during work, detailed on demand.
- One bounded collector shared by surfaces, never per agent.
