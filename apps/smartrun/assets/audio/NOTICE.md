# SmartRun Metronome Audio

- Base asset: `metro_0468.wav`
- Runtime bars:
  - `metro_0468_bar_160.wav`
  - `metro_0468_bar_170.wav`
  - `metro_0468_bar_180.wav`
- Display name: Classic Mechanical / 经典机械
- Source: https://bigsoundbank.com/metronome-a-120bpm-s0468.html
- License: CC0 1.0 / public-domain equivalent
- License details: https://bigsoundbank.com/licenses.html
- Packaged SHA-256: `6955350a08c030c59ffcbcc9933c204d8f6147d7bef870ba042196d58f742f52`

The source recording is the same Classic Mechanical one-shot used by the
AISmartRun Android APK. The packaged base copy only duplicates the mono channel
to stereo for AIUI `Sound` compatibility; it keeps the original approximately
186 ms duration and starts the audible transient within 12 ms. The three
runtime files precompose four beats at 160, 170 and 180 BPM, with the first beat
accented. Runtime clicks keep the real-device-verified 44.1kHz, 16-bit stereo
PCM format, trim the inaudible tail to 100ms and apply a 10ms fade-out. This
reduces packaged audio work without switching to an unverified codec, sample
rate or channel layout.

An earlier AIUI conversion inserted about 100 ms of artificial lead silence.
Rokid real-device logs also showed that every `Sound.play()` rebuilds the
native playback pipeline. Removing the lead and issuing one play per four-beat
bar cuts native pipeline rebuilds by approximately 75%, while the monotonic
scheduler keeps the next bar on the original beat grid. Attribution is not
required by the source license.

Runtime-bar SHA-256:

- 160 BPM: `9c1d1d7cdc94511c4ceb094b718919208f3fa8a31f03fe4388eb3687d72d33de`
- 170 BPM: `211ee9213244da2c5f11eddd8088a1e18180d9123282dca2559f1263055a5fb2`
- 180 BPM: `2362ce6933dcfafe745572c3a1ffeca95319a3c4743e815e0b2ccdba73afc651`
