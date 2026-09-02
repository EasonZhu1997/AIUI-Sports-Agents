import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_METRONOME_BPM,
  METRONOME_ACCENT_VOLUME,
  METRONOME_NORMAL_VOLUME,
  Metronome,
} from '../lib/metronome.js';

class FakeScheduler {
  constructor() {
    this.timeMs = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now = () => this.timeMs;

  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.tasks.set(id, {
      callback,
      dueMs: this.timeMs + Math.max(0, Number(delayMs) || 0),
    });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  nextTask() {
    return [...this.tasks.entries()].sort((a, b) => a[1].dueMs - b[1].dueMs)[0] || null;
  }

  nextDelayMs() {
    const next = this.nextTask();
    return next ? next[1].dueMs - this.timeMs : null;
  }

  advance(ms) {
    const target = this.timeMs + ms;
    while (true) {
      const next = this.nextTask();
      if (!next || next[1].dueMs > target) break;
      this.timeMs = next[1].dueMs;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.timeMs = target;
  }

  fireLateAt(timeMs) {
    this.timeMs = timeMs;
    const next = this.nextTask();
    assert.ok(next, 'expected a pending timer');
    this.tasks.delete(next[0]);
    next[1].callback();
  }
}

class FakeSound {
  constructor(src = 'injected.wav') {
    this.src = src;
    this.volume = 1;
    this.plays = [];
    this.stopCalls = 0;
    this.destroyCalls = 0;
  }

  play() {
    this.plays.push(this.volume);
  }

  stop() {
    this.stopCalls += 1;
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

class FakeAudioPlayer {
  constructor() {
    this.src = '';
    this.volume = 1;
    this.playCalls = 0;
    this.stopCalls = 0;
    this.destroyCalls = 0;
    this.handlers = {
      canplay: null,
      play: null,
      error: null,
    };
  }

  onCanplay(callback) {
    this.handlers.canplay = callback;
  }

  offCanplay(callback) {
    if (this.handlers.canplay === callback) this.handlers.canplay = null;
  }

  onPlay(callback) {
    this.handlers.play = callback;
  }

  offPlay(callback) {
    if (this.handlers.play === callback) this.handlers.play = null;
  }

  onError(callback) {
    this.handlers.error = callback;
  }

  offError(callback) {
    if (this.handlers.error === callback) this.handlers.error = null;
  }

  play() {
    this.playCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }

  destroy() {
    this.destroyCalls += 1;
  }

  emit(name, value) {
    if (typeof this.handlers[name] === 'function') this.handlers[name](value);
  }
}

test('ships low-latency four-beat 80/90/100 RPM Sound-compatible WAV bars', () => {
  const readPcm = (name) => {
    const audio = fs.readFileSync(new URL(`../assets/audio/${name}`, import.meta.url));
    assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(audio.readUInt16LE(20), 1, 'the beat must be uncompressed PCM');
    assert.equal(audio.readUInt16LE(22), 2, 'the Rokid beat must be stereo');
    const sampleRate = audio.readUInt32LE(24);
    assert.equal(sampleRate, name === 'metro_0468.wav' ? 44100 : 22050);
    assert.equal(audio.readUInt16LE(34), 16);
    let offset = 12;
    while (offset + 8 <= audio.length) {
      const chunkId = audio.subarray(offset, offset + 4).toString('ascii');
      const chunkLength = audio.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return audio.subarray(offset + 8, offset + 8 + chunkLength);
      }
      offset += 8 + chunkLength + (chunkLength % 2);
    }
    assert.fail(`${name} must contain a PCM data chunk`);
  };
  const peakInFrames = (pcm, from, to) => {
    let peak = 0;
    for (let frame = from; frame < Math.min(to, pcm.length / 4); frame += 1) {
      peak = Math.max(
        peak,
        Math.abs(pcm.readInt16LE(frame * 4)),
        Math.abs(pcm.readInt16LE(frame * 4 + 2)),
      );
    }
    return peak;
  };

  const sourcePcm = readPcm('metro_0468.wav');
  let firstAudibleFrame = -1;
  for (let frame = 0; frame < sourcePcm.length / 4; frame += 1) {
    if (peakInFrames(sourcePcm, frame, frame + 1) > 100) {
      firstAudibleFrame = frame;
      break;
    }
  }
  assert.ok(firstAudibleFrame >= 0 && firstAudibleFrame <= 529,
    'first click must become audible within 12ms');

  for (const rpm of [80, 90, 100]) {
    const audio = fs.readFileSync(
      new URL(`../assets/audio/metro_0468_bar_${rpm}.wav`, import.meta.url),
    );
    const sampleRate = audio.readUInt32LE(24);
    const pcm = readPcm(`metro_0468_bar_${rpm}.wav`);
    const onsets = [0, 1, 2, 3].map(
      (beat) => Math.round(beat * 60 * sampleRate / rpm),
    );
    const runtimeClickFrames = Math.round(sampleRate * 0.1);
    const finalClickFrames = Math.round(sampleRate * 0.03);
    assert.equal(pcm.length / 4, onsets[3] + finalClickFrames);
    assert.ok(pcm.length / 4 / sampleRate > 0.382,
      `${rpm} RPM bar must stay above the AIUI Sound duration floor`);
    const peaks = onsets.map((onset, beat) => peakInFrames(
      pcm, onset, onset + (beat === 3 ? finalClickFrames : runtimeClickFrames),
    ));
    assert.ok(peaks.every((peak) => peak > 1000), `${rpm} RPM must contain four audible beats`);
    assert.ok(peaks[0] > peaks[1], `${rpm} RPM first beat must be accented`);
    assert.equal(peakInFrames(pcm, pcm.length / 4 - 5, pcm.length / 4), 0,
      `${rpm} RPM final click must end in silence without a cut pop`);
  }
});

test('four-beat playback crosses the native bridge once per complete cadence bar', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({
    sound,
    scheduler,
    bpm: 90,
    beatsPerPlayback: 4,
  });
  assert.equal(metronome.beatsPerPlayback, 4);
  metronome.start();
  assert.equal(sound.plays.length, 1);
  scheduler.advance(4 * 60000 / 90 - 1);
  assert.equal(sound.plays.length, 1);
  scheduler.advance(1);
  assert.equal(sound.plays.length, 2);
});

test('creates a local Sound through the injected constructor and accents every fourth beat', () => {
  const scheduler = new FakeScheduler();
  let created = null;
  class CapturingSound extends FakeSound {
    constructor(src) {
      super(src);
      created = this;
    }
  }

  const metronome = new Metronome({
    SoundCtor: CapturingSound,
    src: 'assets/metro_0468.wav',
    scheduler,
  });

  assert.equal(metronome.bpm, DEFAULT_METRONOME_BPM);
  assert.equal(metronome.start(), true);
  assert.equal(metronome.start(), true);
  assert.equal(scheduler.tasks.size, 1, 'idempotent start must not add another timer');
  scheduler.advance((60000 / DEFAULT_METRONOME_BPM) * 4 + 1);

  assert.equal(created.src, 'assets/metro_0468.wav');
  assert.deepEqual(created.plays.slice(0, 5), [
    METRONOME_ACCENT_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_ACCENT_VOLUME,
  ]);
});

test('corrects callback drift against target time instead of accumulating delay', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 90 });

  metronome.start();
  scheduler.fireLateAt(700);

  assert.equal(sound.plays.length, 2);
  assert.ok(Math.abs(scheduler.nextDelayMs() - (4000 / 3 - 700)) < 0.001);
});

test('skips stale beat slots after a long delay without playing a burst', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 90 });

  metronome.start();
  scheduler.fireLateAt(2300);
  assert.equal(sound.plays.length, 2);
  scheduler.advance(367);

  assert.equal(sound.plays.length, 3);
  assert.equal(sound.plays[2], METRONOME_ACCENT_VOLUME);
});

test('supports 80, 90, 100 and off while active', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 80 });

  metronome.start();
  assert.equal(scheduler.nextDelayMs(), 750);
  metronome.setBpm(90);
  assert.equal(metronome.bpm, 90);
  assert.equal(sound.stopCalls, 1);
  assert.equal(scheduler.tasks.size, 1);
  assert.ok(Math.abs(scheduler.nextDelayMs() - (60000 / 90)) < 0.001);

  metronome.setBpm('off');
  assert.equal(metronome.bpm, 0);
  assert.equal(metronome.running, false);
  assert.equal(scheduler.tasks.size, 0);
  assert.throws(() => metronome.setBpm(85), RangeError);
});

test('stop cancels timers and stale callbacks cannot restart playback', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler });

  metronome.start();
  const staleCallback = scheduler.nextTask()[1].callback;
  assert.equal(metronome.stop(), true);
  assert.equal(metronome.stop(), false);
  assert.equal(sound.stopCalls, 1);
  assert.equal(scheduler.tasks.size, 0);

  staleCallback();
  scheduler.advance(2000);
  assert.equal(sound.plays.length, 1);
  assert.equal(scheduler.tasks.size, 0);
});

test('destroy is idempotent and prevents future starts', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler });

  metronome.start();
  assert.equal(metronome.destroy(), true);
  assert.equal(metronome.destroy(), false);
  assert.equal(sound.stopCalls, 1);
  assert.equal(sound.destroyCalls, 1);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(metronome.start(), false);
});

test('requires either a valid Sound instance or a Sound constructor and local path', () => {
  const scheduler = new FakeScheduler();
  assert.throws(() => new Metronome({ scheduler }), /AudioPlayerCtor or SoundCtor/);
  assert.throws(() => new Metronome({ scheduler, SoundCtor: FakeSound, src: '' }), /local audio path/);
  assert.throws(() => new Metronome({ scheduler, sound: { play() {} } }), /play, stop, and destroy/);
});

test('supports the official AudioPlayer asset-path flow with one bounded canplay retry', () => {
  const scheduler = new FakeScheduler();
  let player = null;
  class CapturingAudioPlayer extends FakeAudioPlayer {
    constructor() {
      super();
      player = this;
    }
  }
  const metronome = new Metronome({
    AudioPlayerCtor: CapturingAudioPlayer,
    src: '/resolved/assets/audio/metro_0468.wav',
    scheduler,
  });

  assert.equal(player.src, '/resolved/assets/audio/metro_0468.wav');
  assert.equal(metronome.start(90), true);
  assert.equal(player.playCalls, 1, 'play is requested immediately like the official sample');

  player.emit('canplay');
  assert.equal(player.playCalls, 2, 'cold start is retried once when native canplay arrives');
  player.emit('canplay');
  assert.equal(player.playCalls, 2, 'canplay cannot create an unbounded replay loop');
  player.emit('play');

  scheduler.advance(667);
  assert.equal(player.stopCalls, 1, 'warm beats rewind before replay');
  assert.equal(player.playCalls, 3);

  metronome.destroy();
  assert.equal(player.destroyCalls, 1);
  assert.equal(player.handlers.canplay, null);
  assert.equal(player.handlers.play, null);
  assert.equal(player.handlers.error, null);
});

test('keeps the skill-confirmed Sound constructor as the production priority', () => {
  const scheduler = new FakeScheduler();
  let soundCreated = 0;
  let playerCreated = 0;
  class CapturingSound extends FakeSound {
    constructor(src) {
      super(src);
      soundCreated += 1;
    }
  }
  class CapturingAudioPlayer extends FakeAudioPlayer {
    constructor() {
      super();
      playerCreated += 1;
    }
  }
  const metronome = new Metronome({
    SoundCtor: CapturingSound,
    AudioPlayerCtor: CapturingAudioPlayer,
    src: '../../assets/audio/metro_0468.wav',
    scheduler,
  });

  assert.equal(soundCreated, 1);
  assert.equal(playerCreated, 0);
  metronome.destroy();
});

test('still plays when an older host rejects Sound volume writes', () => {
  const scheduler = new FakeScheduler();
  const errors = [];
  const sound = {
    playCalls: 0,
    set volume(_value) {
      throw new Error('volume setter unavailable');
    },
    play() {
      this.playCalls += 1;
    },
    stop() {},
    destroy() {},
  };
  const metronome = new Metronome({
    sound,
    scheduler,
    onError(error) {
      errors.push(error);
    },
  });

  assert.equal(metronome.start(90), true);
  assert.equal(sound.playCalls, 1, 'volume compatibility failure must not suppress the beat');
  assert.equal(errors.length, 1);
  scheduler.advance(667);
  assert.equal(sound.playCalls, 2);
});
