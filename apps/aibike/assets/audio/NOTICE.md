# AIBike Cadence Cue Audio

- Assets:
  - `metro_0468.wav`
  - `metro_0468_bar_80.wav`
  - `metro_0468_bar_90.wav`
  - `metro_0468_bar_100.wav`
- Display name: Classic Mechanical / 经典机械
- Source: https://bigsoundbank.com/metronome-a-120bpm-s0468.html
- License: CC0 1.0 / public-domain equivalent
- License details: https://bigsoundbank.com/licenses.html
- Packaged SHA-256:
  - `metro_0468.wav`: `6955350a08c030c59ffcbcc9933c204d8f6147d7bef870ba042196d58f742f52`
  - `metro_0468_bar_80.wav`: `5a2b438e8020a0ba5ab3596c9ae5f7d8c40cb4266530a52e74690ba3e23ee67c`
  - `metro_0468_bar_90.wav`: `717fc57ce62b24dbcf9a15484247da9a40f22eb0d58ae757ce49170233c2c312`
  - `metro_0468_bar_100.wav`: `78facf0595c13269d8e5d255a043e1e528899a3485a7fb7ce761e1d75f5efa1c`

The source recording is a short 44.1 kHz, 16-bit stereo PCM click with its
first audible sample near the file start. The build tool precomposes four-beat
80/90/100 RPM bars with a stronger first beat, a 100 ms click and a 10 ms
fade-out. Runtime therefore crosses the AIUI audio bridge once per four beats
instead of rebuilding native playback for every beat. The audible Classic
Mechanical timbre is unchanged. Attribution is not required by the source
license.
