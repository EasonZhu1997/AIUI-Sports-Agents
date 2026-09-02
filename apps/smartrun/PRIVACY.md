# Privacy boundary

The public source repository contains no production credential, personal run,
raw device capture, stable Bluetooth identifier, route, or location history.

At runtime, heart rate and running metrics are processed on the device for the
HUD and local summary. The public build contains no backend URL and rejects
non-HTTPS coach-backend requests. Those custom backend paths remain inactive
until a developer or user explicitly stores an HTTPS `coach_base_url` in
application storage. AIUI `LanguageModel` is a separate host-managed network
capability and is not gated by `coach_base_url`.

## AIUI LanguageModel path

When the host reports `LanguageModel` as available, the summary feature can
send a prompt over the host's OpenAI-compatible provider path. The prompt may
include mode, duration, distance or steps, average pace, average/maximum heart
rate when present, cadence, heart-rate safety instructions, and a bounded
context made from recent local run summaries or aggregate metrics. On the
compatibility-home path it may also include a locally sanitized profile and up
to two locally sanitized memory snippets returned by the configured coach
backend.

The AIUI API does not expose the selected provider, endpoint, or retention
policy to this application. These prompts do not include raw BLE packets, raw
IMU samples, or stable Bluetooth identifiers, but they can still contain
health-related derived metrics. The deterministic rule fallback works without
the model. The current UI forces the summary capability on and provides no
separate model opt-in/off control, so this path is not production-ready under
the repository's privacy baseline without additional user controls and a
deployment-specific provider notice.

## Optional EverMind memory path

The EverMind-oriented contract is mediated by an operator-configured HTTPS
coach backend; the application does not contain a hard-coded EverMind service
URL, and this repository cannot prove how an external backend stores or routes
the data. Before protected coach-backend calls, the identity flow can request a
server-issued installation ID and long-lived device credential using `app_id`,
then bootstrap with `app_id`, `installation_id`, and that device credential. An
explicitly configured `app_key` may also be sent. A legacy migration can send a
legacy device ID and bearer token only when both are already present. These are
authentication and ownership-migration fields, not analytics identifiers, but
a deployment still needs to protect, rotate, disclose, and delete them as
appropriate.

When configured, the compatibility-home memory-context request can send the
fixed run-summary query and a scoped authorization header. A response may
contain a profile and memory snippets, which that path sanitizes and injects
into the fixed AIUI run-summary prompt. The record path can send the fixed
run-summary question, a reply produced by AIUI LanguageModel or the local rule
fallback, and a source label. A normally queued record also carries a client
record ID derived from its local record time and a non-cryptographic content
hash; low-level request callers can omit the ID when they do not supply one.
These request builders do not attach raw BLE packets, raw IMU samples, or a
stable Bluetooth device identifier.

Generated records use a local FIFO queue capped at five items. The uploader
removes an individual record only after an explicit successful ACK, but adding
a sixth record evicts the oldest item. Clearing application storage and some
owner-identity isolation flows can also remove records without a server ACK.
The public application has no separate user-facing memory-network switch or
retain/delete choice for an existing queue. Removing `coach_base_url` stops
coach-backend attempts; clearing application storage removes locally pending
items.

This means the current contract does **not** satisfy the repository's
production opt-in/off baseline by itself. Before enabling a model provider or
preconfiguring a backend for end users, a deployment must add a visible,
purpose-specific opt-in, an off control, a retain-or-delete choice for existing
queued data, accurate receiver and field disclosure, retention limits, and
accessible deletion/withdrawal. This file is the public source boundary, not a
privacy notice for an unnamed hosted service.

The application also contains separate optional run-summary and calibration
upload client contracts. A deployment operator must disclose every enabled
network path rather than treating this EverMind section as an exhaustive hosted
service notice.

Before sharing logs or screenshots, remove device names and identifiers,
tokens, account data, timestamps that identify a person, and health details
not required to reproduce the problem.
