export function parsePcm16Mono16kWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 46
    || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.readUInt32LE(4) !== audio.length - 8) return null;
  let offset = 12;
  let formatValid = false;
  let dataBytes = null;
  let formatSeen = false;
  let dataSeen = false;
  for (let chunkCount = 0; chunkCount < 64 && offset < audio.length; chunkCount += 1) {
    if (offset + 8 > audio.length) return null;
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (size > audio.length - dataStart) return null;
    if (id === 'fmt ') {
      if (formatSeen || size !== 16) return null;
      formatSeen = true;
      formatValid = audio.readUInt16LE(dataStart) === 1
        && audio.readUInt16LE(dataStart + 2) === 1
        && audio.readUInt32LE(dataStart + 4) === 16_000
        && audio.readUInt32LE(dataStart + 8) === 32_000
        && audio.readUInt16LE(dataStart + 12) === 2
        && audio.readUInt16LE(dataStart + 14) === 16;
    }
    if (id === 'data') {
      if (dataSeen) return null;
      dataSeen = true;
      dataBytes = size;
    }
    offset = dataStart + size + (size % 2);
  }
  if (offset !== audio.length || !formatSeen || !dataSeen || !formatValid
    || !Number.isInteger(dataBytes) || dataBytes < 2 || dataBytes % 2 !== 0) return null;
  const durationSeconds = dataBytes / 32_000;
  return { durationSeconds, dataBytes, sampleRate: 16_000, channels: 1, bitsPerSample: 16 };
}

export function isSupportedPcmWavAudio(audio) {
  return parsePcm16Mono16kWav(audio) !== null;
}
