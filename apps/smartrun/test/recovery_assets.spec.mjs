import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function skipSubBlocks(buffer, start) {
  let offset = start;
  while (offset < buffer.length) {
    const size = buffer[offset];
    offset += 1;
    if (size === 0) return offset;
    offset += size;
  }
  throw new Error('unterminated GIF sub-block sequence');
}

function readColorTable(buffer, start, count, colors) {
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    colors.push([buffer[offset], buffer[offset + 1], buffer[offset + 2]]);
    offset += 3;
  }
  return offset;
}

function parseGif(buffer) {
  const signature = buffer.subarray(0, 6).toString('ascii');
  assert.match(signature, /^GIF8[79]a$/);
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const logicalPacked = buffer[10];
  const colors = [];
  let offset = 13;
  if (logicalPacked & 0x80) {
    const count = 2 ** ((logicalPacked & 0x07) + 1);
    offset = readColorTable(buffer, offset, count, colors);
  }

  let frames = 0;
  let infiniteLoop = false;
  const frameDescriptors = [];
  const framePayloads = [];
  let pendingGraphicControl = null;
  while (offset < buffer.length) {
    const introducer = buffer[offset];
    offset += 1;
    if (introducer === 0x3b) break;
    if (introducer === 0x2c) {
      if (offset + 9 > buffer.length) throw new Error('truncated GIF image descriptor');
      const left = buffer.readUInt16LE(offset);
      const top = buffer.readUInt16LE(offset + 2);
      const frameWidth = buffer.readUInt16LE(offset + 4);
      const frameHeight = buffer.readUInt16LE(offset + 6);
      const imagePacked = buffer[offset + 8];
      frameDescriptors.push({
        left,
        top,
        width: frameWidth,
        height: frameHeight,
        transparent: pendingGraphicControl
          ? pendingGraphicControl.transparent : false,
        disposal: pendingGraphicControl ? pendingGraphicControl.disposal : 0,
      });
      pendingGraphicControl = null;
      offset += 9;
      if (imagePacked & 0x80) {
        const count = 2 ** ((imagePacked & 0x07) + 1);
        offset = readColorTable(buffer, offset, count, colors);
      }
      offset += 1; // LZW minimum code size
      const imageDataStart = offset;
      offset = skipSubBlocks(buffer, offset);
      framePayloads.push(buffer.subarray(imageDataStart, offset).toString('hex'));
      frames += 1;
      continue;
    }
    if (introducer === 0x21) {
      const label = buffer[offset];
      offset += 1;
      if (label === 0xf9) {
        const blockSize = buffer[offset];
        if (blockSize !== 4 || offset + blockSize + 1 >= buffer.length) {
          throw new Error('invalid GIF graphic control extension');
        }
        const packed = buffer[offset + 1];
        pendingGraphicControl = {
          transparent: (packed & 0x01) !== 0,
          disposal: (packed >> 2) & 0x07,
        };
        offset += 1 + blockSize;
        if (buffer[offset] !== 0) throw new Error('unterminated GIF graphic control extension');
        offset += 1;
      } else if (label === 0xff) {
        const appLength = buffer[offset];
        offset += 1;
        const appId = buffer.subarray(offset, offset + appLength).toString('ascii');
        offset += appLength;
        const subBlockStart = offset;
        if ((appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0')
            && buffer[subBlockStart] === 3
            && buffer[subBlockStart + 1] === 1
            && buffer.readUInt16LE(subBlockStart + 2) === 0) {
          infiniteLoop = true;
        }
        offset = skipSubBlocks(buffer, offset);
      } else {
        offset = skipSubBlocks(buffer, offset);
      }
      continue;
    }
    throw new Error(`unsupported GIF block 0x${introducer.toString(16)}`);
  }
  return {
    width,
    height,
    frames,
    infiniteLoop,
    colors,
    frameDescriptors,
    framePayloads,
  };
}

const assets = [
  ['assets/recovery/walk.gif', 6],
  ['assets/recovery/calf.gif', 8],
  ['assets/recovery/quad.gif', 8],
  ['assets/recovery/hamstring.gif', 8],
  ['assets/warmup/march.gif', 6],
  ['assets/warmup/calf-raise.gif', 6],
  ['assets/warmup/butt-kick.gif', 6],
  ['assets/warmup/lateral-shift.gif', 6],
];

test('跑前与跑后 GIF 为 160×160 单绿无限循环，帧数与包体受控', () => {
  for (const [relativePath, expectedFrames] of assets) {
    const name = relativePath.split('/').at(-1);
    const filePath = `${ROOT}/${relativePath}`;
    const buffer = readFileSync(filePath);
    const parsed = parseGif(buffer);
    assert.equal(parsed.width, 160, `${name} width`);
    assert.equal(parsed.height, 160, `${name} height`);
    assert.equal(parsed.frames, expectedFrames, `${name} frame count`);
    assert.equal(parsed.infiniteLoop, true, `${name} must loop forever`);
    assert.ok(statSync(filePath).size < 24 * 1024, `${name} must remain compact`);
    assert.ok(parsed.colors.some(([, green]) => green >= 200), `${name} needs bright green`);
    for (const [red, green, blue] of parsed.colors) {
      if (red <= 4 && green <= 4 && blue <= 4) continue;
      assert.ok(green >= red && green >= blue,
        `${name} palette must remain green-dominant: ${red},${green},${blue}`);
    }
  }
});

test('慢走与四项跑前动作使用完整不透明帧，避免 AIUI 增量帧解码卡住', () => {
  for (const relativePath of [
    'assets/recovery/walk.gif',
    'assets/warmup/march.gif',
    'assets/warmup/calf-raise.gif',
    'assets/warmup/butt-kick.gif',
    'assets/warmup/lateral-shift.gif',
  ]) {
    const parsed = parseGif(readFileSync(`${ROOT}/${relativePath}`));
    assert.equal(parsed.frameDescriptors.length, parsed.frames);
    assert.ok(
      new Set(parsed.framePayloads).size >= 4,
      `${relativePath} must contain visible motion instead of repeating a static frame`,
    );
    for (const [index, frame] of parsed.frameDescriptors.entries()) {
      assert.deepEqual(
        { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
        { left: 0, top: 0, width: 160, height: 160 },
        `${relativePath} frame ${index + 1} must cover the full canvas`,
      );
      assert.equal(
        frame.transparent,
        false,
        `${relativePath} frame ${index + 1} must not depend on transparency disposal`,
      );
    }
  }
});

test('生产跑前/跑后指导只引用 GIF，不回退旧 PNG', () => {
  const recoveryGuide = readFileSync(`${ROOT}/lib/recovery_guide.js`, 'utf8');
  const warmupGuide = readFileSync(`${ROOT}/lib/warmup_guide.js`, 'utf8');
  const page = readFileSync(`${ROOT}/pages/run_hud/index.ink`, 'utf8');
  for (const [relativePath] of assets.filter(([path]) => path.startsWith('assets/recovery/'))) {
    const name = relativePath.split('/').at(-1);
    assert.match(recoveryGuide, new RegExp(`assets/recovery/${name.replace('.', '\\.')}`));
  }
  assert.match(warmupGuide, /assets\/warmup\/march\.gif/);
  assert.match(warmupGuide, /assets\/warmup\/calf-raise\.gif/);
  assert.match(warmupGuide, /assets\/warmup\/butt-kick\.gif/);
  assert.match(warmupGuide, /assets\/warmup\/lateral-shift\.gif/);
  assert.doesNotMatch(warmupGuide, /assets\/recovery\//);
  assert.doesNotMatch(recoveryGuide, /assets\/recovery\/(?:walk|calf|quad|hamstring)\.png/);
  assert.doesNotMatch(warmupGuide, /assets\/(?:warmup|recovery)\/.+\.png/);
  assert.match(page, /recoveryImage:\s*'\.\.\/\.\.\/assets\/recovery\/walk\.gif'/);
});
