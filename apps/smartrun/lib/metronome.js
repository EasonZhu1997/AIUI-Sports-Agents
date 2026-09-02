// AIUI metronome built around the skill-confirmed replay-oriented `Sound` API.
//
// AIUI usage:
//   import { Sound } from 'audio';
//   import { Metronome } from '../../lib/metronome.js';
//
//   const metronome = new Metronome({
//     SoundCtor: Sound,
//     src: '../../assets/audio/metro_0468.wav',
//   });
//
// `Sound` is the production path documented by the current AIUI skill. A
// pre-created Sound instance may be supplied with `sound` for deterministic
// tests, but the AIX runtime always constructs the official local-file player.

export const METRONOME_OFF = 0;
export const DEFAULT_METRONOME_BPM = 180;
export const METRONOME_BPM_OPTIONS = Object.freeze([
  METRONOME_OFF,
  160,
  170,
  180,
]);

// Rokid's open-ear speakers need substantially more headroom than a phone
// speaker. The bundled sample is peak-normalized, so these values remain
// unclipped while keeping the ordinary beat below the four-beat accent.
export const METRONOME_NORMAL_VOLUME = 0.9;
export const METRONOME_ACCENT_VOLUME = 1.0;
export const METRONOME_BEATS_PER_BAR = 4;

function defaultNow() {
  return Date.now();
}

function defaultSetTimeout(callback, delayMs) {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(timerId) {
  clearTimeout(timerId);
}

const DEFAULT_SCHEDULER = Object.freeze({
  now: defaultNow,
  setTimeout: defaultSetTimeout,
  clearTimeout: defaultClearTimeout,
});

function normalizeBpm(value) {
  if (value === METRONOME_OFF || value === 'off' || value == null) {
    return METRONOME_OFF;
  }

  const bpm = Number(value);
  if (!METRONOME_BPM_OPTIONS.includes(bpm)) {
    throw new RangeError('Metronome BPM must be 160, 170, 180, or off');
  }
  return bpm;
}

function normalizeBeatsPerPlayback(value) {
  const beats = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(beats) || beats < 1) {
    throw new RangeError('beatsPerPlayback must be a positive integer');
  }
  return beats;
}

function requireScheduler(value) {
  const scheduler = value || DEFAULT_SCHEDULER;
  if (
    typeof scheduler.now !== 'function'
    || typeof scheduler.setTimeout !== 'function'
    || typeof scheduler.clearTimeout !== 'function'
  ) {
    throw new TypeError('scheduler must provide now, setTimeout, and clearTimeout');
  }
  return scheduler;
}

function reportSafely(onError, error) {
  if (typeof onError !== 'function') return;
  try {
    onError(error);
  } catch (_ignored) {}
}

function createSound({
  sound,
  SoundCtor,
  src,
}) {
  if (sound != null) {
    if (
      typeof sound.play !== 'function'
      || typeof sound.stop !== 'function'
      || typeof sound.destroy !== 'function'
    ) {
      throw new TypeError('sound must provide play, stop, and destroy');
    }
    return sound;
  }

  if (typeof SoundCtor !== 'function') {
    throw new TypeError('SoundCtor is required when sound is not provided');
  }
  if (typeof src !== 'string' || src.trim() === '') {
    throw new TypeError('src must be a non-empty local audio path');
  }

  return new SoundCtor(src);
}

/**
 * Grid-aligned metronome for AIUI's local-file audio APIs.
 *
 * By default each playback represents one beat, preserving the original
 * behavior. A precomposed multi-beat asset can set `beatsPerPlayback` so one
 * `Sound.play()` advances several beat slots. The scheduler always targets the
 * original beat grid. If a callback arrives late, playback slots that are
 * already in the past are skipped instead of being replayed in a burst.
 * `Sound.play()` restarts the local file from its beginning, matching the
 * replay-oriented official sample.
 */
export class Metronome {
  constructor(options = {}) {
    this._scheduler = requireScheduler(options.scheduler);
    this._sound = createSound(options);
    this._destroySound = options.destroySound !== false;
    this._onError = typeof options.onError === 'function' ? options.onError : null;

    this._bpm = normalizeBpm(
      options.bpm === undefined ? DEFAULT_METRONOME_BPM : options.bpm,
    );
    this._beatsPerPlayback = normalizeBeatsPerPlayback(options.beatsPerPlayback);
    this._running = false;
    this._destroyed = false;
    this._timerId = null;
    this._generation = 0;
    this._beatIndex = 0;
    this._nextBeatAtMs = null;
    this._lastAppliedVolume = null;
    this._volumeWriteDisabled = false;
  }

  get bpm() {
    return this._bpm;
  }

  get beatsPerPlayback() {
    return this._beatsPerPlayback;
  }

  get running() {
    return this._running;
  }

  get destroyed() {
    return this._destroyed;
  }

  /** Select 160/170/180 BPM, or 0/"off"/null to disable the metronome. */
  setBpm(value) {
    const bpm = normalizeBpm(value);
    if (this._destroyed || bpm === this._bpm) return this._bpm;

    const restart = this._running && bpm !== METRONOME_OFF;
    if (this._running) this.stop();
    this._bpm = bpm;
    if (restart) this.start();
    return this._bpm;
  }

  /** Start immediately on an accented first beat. Calling twice is a no-op. */
  start(value = this._bpm) {
    if (this._destroyed) return false;

    const bpm = normalizeBpm(value);
    if (bpm === METRONOME_OFF) {
      this._bpm = METRONOME_OFF;
      this.stop();
      return false;
    }

    if (this._running && bpm === this._bpm) return true;
    if (this._running) this.stop();

    this._bpm = bpm;
    this._running = true;
    this._beatIndex = 0;
    this._nextBeatAtMs = this._scheduler.now();
    const generation = ++this._generation;
    this._tick(generation);
    return true;
  }

  /** Stop playback and cancel every future beat. Safe to call repeatedly. */
  stop() {
    const wasRunning = this._running;
    this._running = false;
    this._generation += 1;

    if (this._timerId != null) {
      this._scheduler.clearTimeout(this._timerId);
      this._timerId = null;
    }

    this._beatIndex = 0;
    this._nextBeatAtMs = null;

    if (wasRunning && !this._destroyed) {
      try {
        this._sound.stop();
      } catch (error) {
        this._reportError(error);
      }
    }
    return wasRunning;
  }

  /** Stop and release the Sound instance exactly once. */
  destroy() {
    if (this._destroyed) return false;
    this.stop();
    this._destroyed = true;

    if (this._destroySound) {
      try {
        this._sound.destroy();
      } catch (error) {
        this._reportError(error);
      }
    }
    return true;
  }

  _tick(generation) {
    if (!this._running || this._destroyed || generation !== this._generation) return;

    this._timerId = null;
    const accented = this._beatIndex % METRONOME_BEATS_PER_BAR === 0;
    // Some older AIUI audio bridges can still play a Sound even when their
    // `volume` setter is unavailable or rejects a value. Do not let that
    // optional adjustment suppress the actual beat.
    const targetVolume = accented
      ? METRONOME_ACCENT_VOLUME
      : METRONOME_NORMAL_VOLUME;
    // `volume` crosses the native audio bridge. Consecutive ordinary beats use
    // the same value, so avoid rewriting it until the accent state changes.
    // This removes needless bridge work from the hottest 160–180 BPM path.
    if (!this._volumeWriteDisabled && targetVolume !== this._lastAppliedVolume) {
      try {
        this._sound.volume = targetVolume;
        this._lastAppliedVolume = targetVolume;
      } catch (error) {
        // A few older AIUI hosts expose Sound.play() but reject volume writes.
        // Treat that as a stable capability result so every 333–375ms beat
        // does not pay for another native-bridge exception.
        this._volumeWriteDisabled = true;
        this._reportError(error);
      }
    }
    try {
      this._sound.play();
    } catch (error) {
      this._reportError(error);
    }

    const beatIntervalMs = 60000 / this._bpm;
    const playbackIntervalMs = beatIntervalMs * this._beatsPerPlayback;
    this._beatIndex += this._beatsPerPlayback;
    this._nextBeatAtMs += playbackIntervalMs;

    // Skip whole playback slots that elapsed while this callback was delayed.
    // This keeps the beat/bar phase aligned without replaying stale audio.
    const nowMs = this._scheduler.now();
    if (this._nextBeatAtMs <= nowMs) {
      const missedPlaybacks = Math.floor(
        (nowMs - this._nextBeatAtMs) / playbackIntervalMs,
      ) + 1;
      this._beatIndex += missedPlaybacks * this._beatsPerPlayback;
      this._nextBeatAtMs += missedPlaybacks * playbackIntervalMs;
    }

    if (!this._running || this._destroyed || generation !== this._generation) return;
    const delayMs = Math.max(0, this._nextBeatAtMs - this._scheduler.now());
    this._timerId = this._scheduler.setTimeout(
      () => this._tick(generation),
      delayMs,
    );
  }

  _reportError(error) {
    if (!this._onError) return;
    try {
      this._onError(error);
    } catch (_ignored) {}
  }
}

export function createMetronome(options) {
  return new Metronome(options);
}

export default Metronome;
