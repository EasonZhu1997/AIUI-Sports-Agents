# Privacy

AISmartRower v0.0.1 is offline by default and contains no runtime network request,
analytics, account, advertising, upload or configured server endpoint.

During an active session it reads standard FTMS rowing telemetry and, when the
user explicitly chooses it, standard HRS heart-rate telemetry. Bluetooth device
objects may remain in memory for current-session selection and bounded reconnect,
but device names and stable identifiers are not logged or persisted. Candidate
labels are generated locally rather than copied from advertisements.

Only allowlisted aggregate workout summaries are stored locally. Raw BLE bytes,
per-packet records, RR intervals, native error text, device names and identifiers
are excluded. Clearing the app's host storage removes settings and summaries,
subject to host-runtime behavior.

Do not add networking, analytics, persistent peripheral identity or health-data
export without a separate privacy review, an explicit user opt-in, a user-supplied
HTTPS endpoint, data minimization, deletion controls and updated documentation.
