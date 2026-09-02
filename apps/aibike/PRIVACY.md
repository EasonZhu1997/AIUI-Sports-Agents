# Privacy boundary

AIBike's public build is fully offline by default. It does not ship a production
backend address, does not obtain an identity token, and does not call `wx.request`
without two independent conditions: explicit network opt-in and an explicit valid
HTTPS base URL.

The app can process standard BLE HRS, CSC, Cycling Power, and FTMS Indoor Bike
notifications, plus local glasses IMU data. Runtime diagnostics must not print
stable BLE identifiers, device names, health values, or raw packet bytes. Device
names may be shown transiently in the picker, and a selected host device identifier
may be stored locally to support reconnect; neither is authorized for upload.

Local storage may contain preferences, a selected-device record, ride summaries,
short bounded history, and derived field diagnostics. The public snapshot does not
include captured field data, user activity files, credentials, production logs, or
firmware.

Optional online modules remain for integrators, but they are inert under the public
defaults. Enabling them requires a separate privacy review, user-facing consent,
appropriate platform permissions, an HTTPS service controlled by the integrator,
and compliance with applicable law.
