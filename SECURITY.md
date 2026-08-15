# Security Policy

We take the security and privacy of Vek-Snap and its users seriously. Thank you for
helping keep the project and its community safe.

## Supported versions

Vek-Snap is developed as a rolling release. Security fixes are applied to the most
recent published version only. Please reproduce any issue on the latest release before
reporting it, and upgrade before filing a report where possible.

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, pull request, or
discussion for a suspected vulnerability, and please do not disclose it publicly until a
fix is available.

Preferred: use GitHub's private vulnerability reporting on this repository
(the **Security** tab, then **Report a vulnerability**). This opens a private advisory
visible only to the maintainers.

Alternative: email **contact@squishycode.ai** with a subject line beginning with
`SECURITY:`. If you would like an encrypted channel, say so in a first message that
contains no sensitive detail and we will arrange one.

Please include, where you can:

- A clear description of the issue and its impact.
- The version, operating system, and GPU or driver details.
- Step-by-step reproduction, including any workflow, prompt, file, or model needed.
- A proof of concept, logs, or screenshots if available.

## What to expect

We are a small team and respond on a best-effort basis.

- Acknowledgement of your report within 5 business days.
- An initial assessment and severity triage within 10 business days.
- Coordinated disclosure once a fix is available. With your permission we will credit
  you in the release notes and the advisory.

## Scope

Vek-Snap is an offline, local-first desktop application. By design it binds to
`127.0.0.1` only, disables telemetry, gates outbound network access behind an explicit
opt-in, and authenticates its local API (per-launch HMAC plus Host and Origin checks).
Reports that demonstrate a bypass of these protections are especially valuable.

In scope:

- Bypass of the offline or egress gate, or any unintended outbound connection.
- Local privilege or sandbox escape, remote code execution, or command injection.
- Authentication or authorization flaws in the local API (CSRF, DNS rebinding, HMAC or
  Origin bypass).
- Path traversal or arbitrary file read and write through the app's routes.
- Exposure of secrets, tokens, or user content by the application itself.

Generally out of scope:

- Issues that require the user to run untrusted models, workflows, or third-party
  ComfyUI custom nodes. Treat downloaded models and workflows as untrusted content.
- Vulnerabilities in third-party dependencies or in ComfyUI itself. Please report those
  upstream; tell us if Vek-Snap's configuration makes the impact materially worse.
- Findings that require physical access to an already-compromised machine, or social
  engineering of the user.

## Safe harbor

We will not pursue or support legal action against researchers who act in good faith,
avoid privacy violations and data destruction, and give us a reasonable chance to
address an issue before any public disclosure. If in doubt, ask first.
