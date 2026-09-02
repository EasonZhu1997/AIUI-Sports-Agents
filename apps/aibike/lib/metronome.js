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
// `Sound` remains the production path. A pre-created Sound instance may be
// supplied with `sound`; the AudioPlayer adapter is an explicit compatibility
// path for hosts where callers deliberately opt into that API.

export const METRONOME_OFF = 0;
export const DEFAULT_METRONOME_BPM = 90;
export const METRONOME_BPM_OPTIONS = Object.freeze([
  METRONOME_OFF,
  80,
  90,
  100,
]);

// Rokid's open-ear speakers need substantially more headroom than a phone
// speaker. The bundled sample is peak-normalized, so these values remain
// unclipped while keeping the ordinary beat below the four-beat accent.
export const METRONOME_NORMAL_VOLUME = 0.72;
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
    throw new RangeError('Cadence tone must be 80, 90, 100 RPM, or off');
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

function removePlayerListener(player, name, callback) {
  const method = player && player[name];
  if (typeof method !== 'function') return;
  try {
    method.call(player, callback);
  } catch (_ignored) {
    try {
      method.call(player);
    } catch (_ignoredAgain) {}
  }
}

/**
 * Replay adapter for the official AIUI `AudioPlayer` sample path.
 *
 * `AudioPlayer` exposes readiness/error events while `Sound` does not. A play
 * request is sent immediately (matching the sample's "new instance and play"
 * path) and is retried once when `canplay` arrives if the native bridge did not
 * emit `play`. This covers the glasses' cold audio-route startup without
 * delaying warm beats or starting an unbounded retry loop.
 */
class AudioPlayerSoundAdapter {
  constructor(AudioPlayerCtor, src, onError) {
    this._player = new AudioPlayerCtor();
    this._onError = typeof onError === 'function' ? onError : null;
    this._destroyed = false;
    this._startedOnce = false;
    this._pendingPlay = false;
    this._canplayRetryUsed = false;
    this._volume = 1;

    this._handleCanplay = () => {
      if (
        this._destroyed
        || !this._pendingPlay
        || this._canplayRetryUsed
      ) {
        return;
      }
      this._canplayRetryUsed = true;
      this._restartPlayer(false);
    };
    this._handlePlay = () => {
      this._pendingPlay = false;
    };
    this._handleError = (error) => {
      this._pendingPlay = false;
      reportSafely(this._onError, error || new Error('AudioPlayer playback failed'));
    };

    if (typeof this._player.onCanplay === 'function') {
      this._player.onCanplay(this._handleCanplay);
    }
    if (typeof this._player.onPlay === 'function') {
      this._player.onPlay(this._handlePlay);
    }
    if (typeof this._player.onError === 'function') {
      this._player.onError(this._handleError);
    }

    // Assign the statically imported asset path only after event listeners are
    // installed: some native hosts can report canplay synchronously.
    this._player.src = src;
  }

  get volume() {
    if (this._destroyed) return this._volume;
    const value = this._player.volume;
    return Number.isFinite(value) ? value : this._volume;
  }

  set volume(value) {
    this._volume = value;
    if (!this._destroyed) this._player.volume = value;
  }

  play() {
    if (this._destroyed) throw new Error('AudioPlayer adapter is destroyed');
    this._pendingPlay = true;
    this._canplayRetryUsed = false;
    this._restartPlayer(this._startedOnce);
    this._startedOnce = true;
  }

  stop() {
    if (this._destroyed) return;
    this._pendingPlay = false;
    if (typeof this._player.stop === 'function') this._player.stop();
  }

  destroy() {
    if (this._destroyed) return;
    this.stop();
    this._destroyed = true;
    removePlayerListener(this._player, 'offCanplay', this._handleCanplay);
    removePlayerListener(this._player, 'offPlay', this._handlePlay);
    removePlayerListener(this._player, 'offError', this._handleError);
    this._player.destroy();
  }

  _restartPlayer(resetFirst) {
    try {
      if (resetFirst && typeof this._player.stop === 'function') {
        this._player.stop();
      }
      this._player.play();
    } catch (error) {
      this._pendingPlay = false;
      reportSafely(this._onError, error);
    }
  }
}

function createSound({
  sound,
  SoundCtor,
  AudioPlayerCtor,
  src,
  onError,
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

  if (
    typeof AudioPlayerCtor !== 'function'
    && typeof SoundCtor !== 'function'
  ) {
    throw new TypeError(
      'AudioPlayerCtor or SoundCtor is required when sound is not provided',
    );
  }
  if (typeof src !== 'string' || src.trim() === '') {
    throw new TypeError('src must be a non-empty local audio path');
  }

  // Sound remains the production path because it is the media API confirmed
  // by the current AIUI skill. AudioPlayer is an explicit compatibility path
  // only when callers do not supply SoundCtor.
  if (typeof SoundCtor === 'function') {
    return new SoundCtor(src);
  }

  return new AudioPlayerSoundAdapter(AudioPlayerCtor, src, onError);
}

/**
 * Four-beat metronome for AIUI's local-file audio APIs.
 *
 * The scheduler always targets the original beat grid. If a callback arrives
 * late, its next delay is shortened; beats that are already in the past are
 * skipped instead of being played in a burst. The AudioPlayer adapter uses its
 * readiness events; the legacy Sound fallback remains replay-oriented.
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

  /** Select 80/90/100 RPM, or 0/"off"/null to disable the cadence tone. */
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
    if (!this._volumeWriteDisabled && targetVolume !== this._lastAppliedVolume) {
      try {
        this._sound.volume = targetVolume;
        this._lastAppliedVolume = targetVolume;
      } catch (error) {
        // Treat a rejected setter as a stable host capability result. Repeating
        // the same native-bridge exception every beat can itself disturb audio.
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
    // This keeps the bar phase aligned without replaying stale audio in a burst.
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
