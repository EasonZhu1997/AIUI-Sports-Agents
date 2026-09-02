import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets/audio/metro_0468.wav');
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const CLICK_FRAMES = Math.round(SAMPLE_RATE * 0.1);
const FADE_FRAMES = Math.round(SAMPLE_RATE * 0.01);
const TEMPOS = [160, 170, 180];

function fail(message) {
  throw new Error(message);
}

function findChunk(bytes, id) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    if (chunkId === id) return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

function readSourcePcm() {
  const bytes = fs.readFileSync(SOURCE);
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
      || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
    fail('metronome source must be RIFF/WAVE');
  }
  const fmt = findChunk(bytes, 'fmt ');
  const data = findChunk(bytes, 'data');
  if (!fmt || !data
      || bytes.readUInt16LE(fmt.offset) !== 1
      || bytes.readUInt16LE(fmt.offset + 2) !== CHANNELS
      || bytes.readUInt32LE(fmt.offset + 4) !== SAMPLE_RATE
      || bytes.readUInt16LE(fmt.offset + 14) !== BITS_PER_SAMPLE) {
    fail('metronome source must remain 44.1kHz 16-bit stereo PCM');
  }
  if (data.size < CLICK_FRAMES * FRAME_BYTES) {
    fail('metronome source is shorter than the 100ms runtime click');
  }
  return bytes.subarray(data.offset, data.offset + data.size);
}

function runtimeClick(sourcePcm) {
  const click = Buffer.alloc(CLICK_FRAMES * FRAME_BYTES);
  for (let frame = 0; frame < CLICK_FRAMES; frame += 1) {
    const fadeStart = CLICK_FRAMES - FADE_FRAMES;
    const fade = frame < fadeStart
      ? 1
      : (CLICK_FRAMES - 1 - frame) / Math.max(1, FADE_FRAMES - 1);
    for (let channel = 0; channel < CHANNELS; channel += 1) {
      const offset = frame * FRAME_BYTES + channel * BYTES_PER_SAMPLE;
      click.writeInt16LE(
        Math.round(sourcePcm.readInt16LE(offset) * Math.max(0, fade)),
        offset,
      );
    }
  }
  return click;
}

function pcmWav(pcm) {
  const bytes = Buffer.alloc(44 + pcm.length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36 + pcm.length, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(CHANNELS, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * FRAME_BYTES, 28);
  bytes.writeUInt16LE(FRAME_BYTES, 32);
  bytes.writeUInt16LE(BITS_PER_SAMPLE, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(pcm.length, 40);
  pcm.copy(bytes, 44);
  return bytes;
}

function buildBar(click, bpm) {
  const onsetFrames = [0, 1, 2, 3].map(
    (beat) => Math.round(beat * 60 * SAMPLE_RATE / bpm),
  );
  const totalFrames = onsetFrames[3] + CLICK_FRAMES;
  const mixed = new Float64Array(totalFrames * CHANNELS);
  onsetFrames.forEach((onset, beat) => {
    const gain = beat === 0 ? 1 : 0.9;
    for (let frame = 0; frame < CLICK_FRAMES; frame += 1) {
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const sourceOffset = frame * FRAME_BYTES
          + channel * BYTES_PER_SAMPLE;
        const targetIndex = (onset + frame) * CHANNELS + channel;
        mixed[targetIndex] += click.readInt16LE(sourceOffset) * gain;
      }
    }
  });
  const pcm = Buffer.alloc(totalFrames * FRAME_BYTES);
  for (let index = 0; index < mixed.length; index += 1) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(mixed[index])));
    pcm.writeInt16LE(sample, index * BYTES_PER_SAMPLE);
  }
  return pcmWav(pcm);
}

const click = runtimeClick(readSourcePcm());
for (const bpm of TEMPOS) {
  const target = path.join(
    ROOT,
    `assets/audio/metro_0468_bar_${bpm}.wav`,
  );
  fs.writeFileSync(target, buildBar(click, bpm));
  const size = fs.statSync(target).size;
  console.log(`Built ${path.relative(ROOT, target)} (${size} bytes)`);
}
