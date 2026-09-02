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
    this._volume = 1;
    this.volumeWrites = [];
    this.plays = [];
    this.stopCalls = 0;
    this.destroyCalls = 0;
  }

  get volume() {
    return this._volume;
  }

  set volume(value) {
    this._volume = value;
    this.volumeWrites.push(value);
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

test('ships the Classic Mechanical beat in the official Sound-compatible WAV shape', () => {
  const audio = fs.readFileSync(
    new URL('../assets/audio/metro_0468.wav', import.meta.url),
  );
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(audio.readUInt16LE(20), 1, 'the beat must be uncompressed PCM');
  assert.equal(audio.readUInt16LE(22), 2, 'the Rokid Sound fixture-compatible beat must be stereo');
  assert.equal(audio.readUInt32LE(24), 44100);
  assert.equal(audio.readUInt16LE(34), 16);

  let offset = 12;
  let pcm = null;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.subarray(offset, offset + 4).toString('ascii');
    const chunkLength = audio.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      pcm = audio.subarray(offset + 8, offset + 8 + chunkLength);
      break;
    }
    offset += 8 + chunkLength + (chunkLength % 2);
  }
  assert.ok(pcm, 'WAV must contain a PCM data chunk');

  const frameBytes = 4;
  const frameCount = pcm.length / frameBytes;
  const durationMs = frameCount * 1000 / 44100;
  assert.ok(durationMs >= 175 && durationMs <= 200,
    `APK-derived one-shot must stay inside the verified 175-200ms window, actual ${durationMs}ms`);
  let firstAudibleFrame = -1;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const left = Math.abs(pcm.readInt16LE(frame * frameBytes));
    const right = Math.abs(pcm.readInt16LE(frame * frameBytes + 2));
    if (Math.max(left, right) > 100) {
      firstAudibleFrame = frame;
      break;
    }
  }
  assert.ok(firstAudibleFrame >= 0, 'one-shot must contain an audible transient');
  assert.ok(firstAudibleFrame < 530,
    'audible transient must start within 12ms; artificial lead silence causes the glasses host to rebuild before the click');

  let tailPeak = 0;
  const tailFrames = Math.round(44100 * 0.01);
  for (let frame = frameCount - tailFrames; frame < frameCount; frame += 1) {
    const left = Math.abs(pcm.readInt16LE(frame * frameBytes));
    const right = Math.abs(pcm.readInt16LE(frame * frameBytes + 2));
    tailPeak = Math.max(tailPeak, left, right);
  }
  assert.ok(tailPeak < 32, `one-shot tail must fade to silence, peak=${tailPeak}`);
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
  assert.equal(metronome.beatsPerPlayback, 1);
  assert.equal(metronome.start(), true);
  assert.equal(metronome.start(), true);
  assert.equal(scheduler.tasks.size, 1, 'idempotent start must not add another timer');
  scheduler.advance((60000 / 180) * 4 + 1);

  assert.equal(created.src, 'assets/metro_0468.wav');
  assert.deepEqual(created.plays.slice(0, 5), [
    METRONOME_ACCENT_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_ACCENT_VOLUME,
  ]);
});

test('schedules one playback per four-beat bar at 160, 170, and 180 BPM', () => {
  for (const bpm of [160, 170, 180]) {
    const scheduler = new FakeScheduler();
    const sound = new FakeSound();
    const metronome = new Metronome({
      sound,
      scheduler,
      bpm,
      beatsPerPlayback: 4,
    });
    const barIntervalMs = (60000 / bpm) * 4;

    assert.equal(metronome.beatsPerPlayback, 4);
    assert.equal(metronome.start(), true);
    assert.deepEqual(sound.plays, [METRONOME_ACCENT_VOLUME]);
    assert.ok(Math.abs(scheduler.nextDelayMs() - barIntervalMs) < 0.001);

    scheduler.advance(barIntervalMs);
    assert.deepEqual(sound.plays, [
      METRONOME_ACCENT_VOLUME,
      METRONOME_ACCENT_VOLUME,
    ]);
    assert.ok(Math.abs(scheduler.nextDelayMs() - barIntervalMs) < 0.001);
  }
});

test('corrects callback drift against target time instead of accumulating delay', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 180 });

  metronome.start();
  scheduler.fireLateAt(350);

  assert.equal(sound.plays.length, 2);
  assert.ok(Math.abs(scheduler.nextDelayMs() - (2000 / 3 - 350)) < 0.001);
});

test('avoids redundant native volume writes across consecutive ordinary beats', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 180 });

  metronome.start();
  scheduler.advance(1001);
  assert.deepEqual(sound.volumeWrites, [
    METRONOME_ACCENT_VOLUME,
    METRONOME_NORMAL_VOLUME,
  ], 'three ordinary beats should share one native volume write');

  scheduler.advance(334);
  assert.deepEqual(sound.volumeWrites, [
    METRONOME_ACCENT_VOLUME,
    METRONOME_NORMAL_VOLUME,
    METRONOME_ACCENT_VOLUME,
  ]);
});

test('skips stale beat slots after a long delay without playing a burst', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 180 });

  metronome.start();
  scheduler.fireLateAt(1100);
  assert.equal(sound.plays.length, 2);
  scheduler.advance(234);

  assert.equal(sound.plays.length, 3);
  assert.equal(sound.plays[2], METRONOME_ACCENT_VOLUME);
});

test('four-beat playback skips late bars without catch-up bursts', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({
    sound,
    scheduler,
    bpm: 180,
    beatsPerPlayback: 4,
  });
  const barIntervalMs = (60000 / 180) * 4;
  const lateAtMs = barIntervalMs * 3 + 100;

  metronome.start();
  scheduler.fireLateAt(lateAtMs);
  assert.equal(sound.plays.length, 2, 'late delivery must trigger only the current callback');

  scheduler.advance(0);
  assert.equal(sound.plays.length, 2, 'skipped bars must not be replayed immediately');
  assert.ok(Math.abs(
    scheduler.nextDelayMs() - (barIntervalMs - 100),
  ) < 0.001);

  scheduler.advance(barIntervalMs - 100);
  assert.equal(sound.plays.length, 3);
  assert.equal(sound.plays[2], METRONOME_ACCENT_VOLUME);
});

test('supports 160, 170, 180 and off while running', () => {
  const scheduler = new FakeScheduler();
  const sound = new FakeSound();
  const metronome = new Metronome({ sound, scheduler, bpm: 160 });

  metronome.start();
  assert.equal(scheduler.nextDelayMs(), 375);
  metronome.setBpm(170);
  assert.equal(metronome.bpm, 170);
  assert.equal(sound.stopCalls, 1);
  assert.equal(scheduler.tasks.size, 1);
  assert.ok(Math.abs(scheduler.nextDelayMs() - (60000 / 170)) < 0.001);

  metronome.setBpm('off');
  assert.equal(metronome.bpm, 0);
  assert.equal(metronome.running, false);
  assert.equal(scheduler.tasks.size, 0);
  assert.throws(() => metronome.setBpm(165), RangeError);
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
  assert.throws(() => new Metronome({ scheduler }), /SoundCtor/);
  assert.throws(() => new Metronome({ scheduler, SoundCtor: FakeSound, src: '' }), /local audio path/);
  assert.throws(() => new Metronome({ scheduler, sound: { play() {} } }), /play, stop, and destroy/);
  for (const beatsPerPlayback of [0, -1, 1.5, 'not-a-number']) {
    assert.throws(
      () => new Metronome({
        scheduler,
        sound: new FakeSound(),
        beatsPerPlayback,
      }),
      /positive integer/,
    );
  }
});

test('uses the skill-confirmed Sound constructor and binds the local asset once', () => {
  const scheduler = new FakeScheduler();
  let soundCreated = 0;
  class CapturingSound extends FakeSound {
    constructor(src) {
      super(src);
      soundCreated += 1;
    }
  }
  const metronome = new Metronome({
    SoundCtor: CapturingSound,
    src: '../../assets/audio/metro_0468.wav',
    scheduler,
  });

  assert.equal(soundCreated, 1);
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

  assert.equal(metronome.start(180), true);
  assert.equal(sound.playCalls, 1, 'volume compatibility failure must not suppress the beat');
  assert.equal(errors.length, 1);
  scheduler.advance(334);
  assert.equal(sound.playCalls, 2);
  assert.equal(errors.length, 1, 'unsupported volume should be probed only once');
});
