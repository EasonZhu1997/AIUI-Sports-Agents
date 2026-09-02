# Privacy boundary

The public source repository contains no production credential, personal run,
raw device capture, stable Bluetooth identifier, route, or location history.

At runtime, heart rate and running metrics are processed on the device for the
HUD and local summary. The public build contains no backend URL and rejects
non-HTTPS network requests. Network features remain inactive until a developer
or user explicitly stores an HTTPS `coach_base_url` in application storage.

Before sharing logs or screenshots, remove device names and identifiers,
tokens, account data, timestamps that identify a person, and health details
not required to reproduce the problem.
