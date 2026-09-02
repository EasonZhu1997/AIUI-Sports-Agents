# Security policy

Report security issues privately through GitHub Security Advisories for the parent
repository when available. Do not publish credentials, device identifiers, health
data, raw BLE packets, private endpoints, or exploit details in a public issue.

The public build is offline by default. A network request is rejected before
`wx.request` unless both an explicit opt-in flag and a valid HTTPS base URL are
present in local settings. Keep those defaults when reproducing an issue.

Supported source line: the current `apps/aibike` snapshot. Hardware, firmware,
host-runtime, signing, AIUI Studio, and store issues remain outside the source-only
support boundary unless the report includes reproducible evidence.
