const TARGET_SAMPLE_RATE = 16_000;

function clampSample(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function resampleLinear(samples, sourceSampleRate, targetSampleRate = TARGET_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('Decoded audio is empty');
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new TypeError('Decoded audio sample rate is invalid');
  }
  const outputLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * sourceSampleRate / targetSampleRate;
    const left = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const right = Math.min(samples.length - 1, left + 1);
    const mix = sourcePosition - left;
    output[index] = samples[left] + ((samples[right] - samples[left]) * mix);
  }
  return output;
}

export function encodePcm16Mono16kWav(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new TypeError('PCM samples are required');
  }
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampSample(samples[index]);
    view.setInt16(44 + (index * bytesPerSample), sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

export async function convertRecordingToPcm16Wav(blob, options = {}) {
  if (!blob || typeof blob.arrayBuffer !== 'function') throw new TypeError('Recording blob is required');
  const AudioContext = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
  const BlobConstructor = options.Blob || globalThis.Blob;
  if (!AudioContext || !BlobConstructor) throw new TypeError('Browser audio conversion is unavailable');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!decoded || decoded.numberOfChannels < 1 || decoded.length < 1) {
      throw new TypeError('Decoded audio is empty');
    }
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const values = decoded.getChannelData(channel);
      for (let index = 0; index < decoded.length; index += 1) mono[index] += values[index] / decoded.numberOfChannels;
    }
    const samples = resampleLinear(mono, decoded.sampleRate);
    return Object.freeze({
      blob: new BlobConstructor([encodePcm16Mono16kWav(samples)], { type: 'audio/wav' }),
      durationSeconds: samples.length / TARGET_SAMPLE_RATE,
    });
  } finally {
    await context.close?.().catch?.(() => {});
  }
}
