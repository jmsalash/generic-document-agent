import { test } from 'node:test';
import assert from 'node:assert/strict';
import { f32ToPcm16B64, pcm16B64ToF32, rms, downsampleTo16k } from '../../widget/audio.js';

test('PCM16 base64 round trip', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const out = pcm16B64ToF32(f32ToPcm16B64(input));
  assert.equal(out.length, input.length);
  input.forEach((v, i) => assert.ok(Math.abs(out[i] - v) < 1e-4, `${i}: ${out[i]} vs ${v}`));
});

test('samples outside [-1, 1] are clamped', () => {
  assert.equal(f32ToPcm16B64(new Float32Array([2, -2])), f32ToPcm16B64(new Float32Array([1, -1])));
});

test('encoding is little-endian PCM16', () => {
  assert.equal(f32ToPcm16B64(new Float32Array([1])), '/38=');
});

test('long audio encodes without overflowing the call stack', () => {
  const b64 = f32ToPcm16B64(new Float32Array(400000).fill(0.1));
  assert.equal(pcm16B64ToF32(b64).length, 400000);
});

test('rms measures level', () => {
  assert.equal(rms(new Float32Array(100)), 0);
  assert.ok(Math.abs(rms(new Float32Array(100).fill(0.5)) - 0.5) < 1e-6);
  assert.equal(rms(new Float32Array(0)), 0);
});

test('downsampling to 16 kHz', () => {
  assert.equal(downsampleTo16k(new Float32Array(48000).fill(0.25), 48000).length, 16000);
  assert.ok(Math.abs(downsampleTo16k(new Float32Array(48000).fill(0.25), 48000)[100] - 0.25) < 1e-6);
  assert.equal(downsampleTo16k(new Float32Array(44100), 44100).length, 16000);
  const same = new Float32Array(1600);
  assert.equal(downsampleTo16k(same, 16000), same);
});
