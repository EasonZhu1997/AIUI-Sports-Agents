# Security Policy

Report vulnerabilities through GitHub private vulnerability reporting when it is
enabled, or by a non-public contact method on the maintainer profile. Do not post
credentials, device identifiers, health data, firmware or BLE captures in Issues.

The released runtime is telemetry-only. It does not discover, subscribe to or
write Fitness Machine Control Point `0x2AD9`; it cannot start or stop a machine,
change resistance or set a program. Any future physical-control work requires a
separate threat model, explicit confirmation, capability/range checks, matching
protocol responses, rollback and real-device safety acceptance.

Production diagnostics are bounded stage/reason enums. They must never contain
device names, stable identifiers, raw packets or native error strings. The public
tree must not contain keys, tokens, private endpoints, firmware, captures, AIX
archives or host-specific paths.
