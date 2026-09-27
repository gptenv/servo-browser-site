import {
  ALL_FORMATS,
  AudioSampleSink,
  Input,
  ReadableStreamSource,
  VideoSampleSink,
} from 'mediabunny';

const MAX_PLAYERS = 4;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const RESUME_PENDING_BYTES = 2 * 1024 * 1024;
const SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_FRAME_BYTES = 40 * 1024 * 1024;
const MAX_AUDIO_CHANNELS = 8;
let activePlayers = 0;

const OP = Object.freeze({
  create: 0,
  contentType: 1,
  push: 2,
  end: 3,
  play: 4,
  pause: 5,
  stop: 6,
  seek: 7,
  muted: 8,
  volume: 9,
  rate: 10,
  destroy: 11,
  inputSize: 12,
  seekable: 13,
  buffering: 14,
});

const EVENT = Object.freeze({
  metadata: 0,
  state: 1,
  ended: 2,
  enoughData: 3,
  needData: 4,
  position: 5,
  error: 6,
  duration: 7,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Worker-side native media adapter for Servo-WASM. Mediabunny demuxes
 * progressive input; browser WebCodecs decoders produce samples. Video frames
 * are copied into Servo's existing paint path and ordinary audio is streamed
 * back to the page's browser AudioContext.
 */
export function createServoMediaHost({ emit = () => {} } = {}) {
  const players = new Map();

  const sendEvent = (state, kind, value0 = 0, value1 = 0, data = new Uint8Array()) => {
    if (state.closed) return;
    state.callbacks?.event(state.id, kind, value0, value1, data);
    emit({ type: 'media-activity', playerId: state.id });
  };

  const emitState = (state) => emit({
    type: 'media-state', playerId: state.id, playing: state.playing,
    hasVideo: state.hasVideo, hasAudio: state.hasAudio,
    prerolled: state.hasPrerolledVideo,
  });

  const updatePosition = (state) => {
    if (!state.playing) return state.currentTime;
    return state.baseTime + Math.max(0, performance.now() - state.playStartedAt) / 1000 * state.rate;
  };

  const notify = (state) => {
    for (const resolve of state.waiters.splice(0)) resolve();
  };

  const waitForPlay = async (state) => {
    while (!state.closed && !state.playing) {
      await new Promise((resolve) => state.waiters.push(resolve));
    }
    return !state.closed;
  };

  const pace = async (state, timestamp) => {
    while (await waitForPlay(state)) {
      const dueAt = state.playStartedAt + ((timestamp - state.baseTime) / state.rate) * 1000;
      const delay = dueAt - performance.now();
      if (delay <= 0) return true;
      await sleep(Math.min(delay, 60));
    }
    return false;
  };

  const fail = (state, error) => {
    if (state.closed || state.failed) return;
    state.failed = true;
    state.playing = false;
    notify(state);
    const message = String(error?.message ?? error).slice(0, 4096);
    sendEvent(state, EVENT.error, 0, 0, textEncoder.encode(message));
    emit({ type: 'media-error', playerId: state.id, message });
    emitState(state);
  };

  const finishIfReady = (state) => {
    if (!state.closed && state.inputEnded && state.tracksDone === state.trackCount) {
      state.playing = false;
      sendEvent(state, EVENT.ended);
      emitState(state);
    }
  };

  const markPrerollTrackReady = (state) => {
    state.prerollTracksReady++;
    if (state.prerollTracksReady === state.trackCount && !state.prerollStateSent) {
      state.prerollStateSent = true;
      // Servo uses its initial Paused/Playing state notification to advance
      // HAVE_METADATA to HAVE_ENOUGH_DATA and run its ordinary autoplay path.
      // The host has now decoded one sample for each primary track.
      sendEvent(state, EVENT.state, 0);
    }
  };

  const decodeVideoSample = async (sample) => {
    const frame = sample.toVideoFrame();
    try {
      const width = frame.codedWidth;
      const height = frame.codedHeight;
      if (!width || !height || width > 8192 || height > 8192) {
        throw new RangeError('Decoded video frame dimensions are outside the supported range.');
      }
      const pixels = new Uint8Array(frame.allocationSize({ format: 'BGRA' }));
      if (pixels.byteLength !== width * height * 4 || pixels.byteLength > MAX_VIDEO_FRAME_BYTES) {
        throw new RangeError('Decoded video frame exceeds the safe frame buffer limit.');
      }
      await frame.copyTo(pixels, { format: 'BGRA' });
      return { width, height, pixels };
    } finally {
      frame.close();
    }
  };

  const decodeAudioSample = (state, sample) => {
    const channels = sample.numberOfChannels;
    const frames = sample.numberOfFrames;
    if (!channels || channels > MAX_AUDIO_CHANNELS || frames * channels > 1_048_576) {
      throw new RangeError('Decoded audio sample exceeds the supported channel or frame limit.');
    }
    const planar = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
      const plane = new Float32Array(frames);
      sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      const gain = state.muted ? 0 : state.volume;
      const offset = channel * frames;
      if (gain === 0) planar.fill(0, offset, offset + frames);
      else if (gain === 1) planar.set(plane, offset);
      else {
        for (let i = 0; i < frames; i++) planar[offset + i] = plane[i] * gain;
      }
    }
    return { channels, frames, planar };
  };

  const outputAudioSample = (state, sample, decoded) => {
    state.currentTime = Math.max(state.currentTime, sample.timestamp);
    const data = new Uint8Array(decoded.planar.buffer);
    if (state.audioViaServo) {
      state.callbacks.audioFrame(state.id, decoded.channels, sample.sampleRate, data);
    } else {
      emit({
        type: 'media-audio', playerId: state.id, channels: decoded.channels,
        sampleRate: sample.sampleRate, timestamp: sample.timestamp,
        data: decoded.planar.buffer,
      }, [decoded.planar.buffer]);
    }
    sendEvent(state, EVENT.position, state.currentTime);
  };

  async function playVideo(state, sink) {
    let firstSample = true;
    try {
      for await (const sample of sink.samples(state.seekTarget ?? 0)) {
        try {
          if (sample.timestamp + (sample.duration ?? 0) < (state.seekTarget ?? 0)) continue;
          if (firstSample) {
            const decoded = await decodeVideoSample(sample);
            if (state.closed) return;
            state.callbacks.videoFrame(state.id, decoded.width, decoded.height, decoded.pixels);
            state.hasPrerolledVideo = true;
            emitState(state);
            markPrerollTrackReady(state);
            firstSample = false;
            // Keep this sample as the still frame while paused. The next
            // sample is paced from the normal play command below.
            if (!(await waitForPlay(state))) return;
            continue;
          }
          if (!(await waitForPlay(state))) return;
          if (!(await pace(state, Math.max(sample.timestamp, state.seekTarget ?? 0)))) continue;
          const decoded = await decodeVideoSample(sample);
          if (state.closed) return;
          state.currentTime = Math.max(state.currentTime, sample.timestamp);
          state.callbacks.videoFrame(state.id, decoded.width, decoded.height, decoded.pixels);
          sendEvent(state, EVENT.position, state.currentTime);
        } finally {
          sample.close();
        }
      }
    } catch (error) {
      if (!state.closed) fail(state, error);
    } finally {
      state.tracksDone++;
      finishIfReady(state);
    }
  }

  async function playAudio(state, sink) {
    let firstSample = true;
    try {
      for await (const sample of sink.samples(state.seekTarget ?? 0)) {
        try {
          if (sample.timestamp + sample.duration < (state.seekTarget ?? 0)) continue;
          const decoded = decodeAudioSample(state, sample);
          if (firstSample) {
            firstSample = false;
            markPrerollTrackReady(state);
          }
          if (!(await waitForPlay(state))) return;
          if (!(await pace(state, Math.max(sample.timestamp, state.seekTarget ?? 0)))) continue;
          if (state.closed) return;
          outputAudioSample(state, sample, decoded);
        } finally {
          sample.close();
        }
      }
    } catch (error) {
      if (!state.closed) fail(state, error);
    } finally {
      state.tracksDone++;
      finishIfReady(state);
    }
  }

  async function initialize(state) {
    try {
      const [videoTrack, audioTrack] = await Promise.all([
        state.input.getPrimaryVideoTrack(),
        state.input.getPrimaryAudioTrack(),
      ]);
      if (state.closed) return;
      if (!videoTrack && !audioTrack) throw new Error('No playable audio or video track was found.');
      if (videoTrack && !(await videoTrack.canDecode())) {
        throw new Error('This browser does not provide a WebCodecs decoder for the video codec in this file.');
      }
      if (audioTrack && !(await audioTrack.canDecode())) {
        throw new Error('This browser does not provide a WebCodecs decoder for the audio codec in this file.');
      }
      const [duration, width, height] = await Promise.all([
        state.input.getDurationFromMetadata(),
        videoTrack?.getCodedWidth() ?? 0,
        videoTrack?.getCodedHeight() ?? 0,
      ]);
      state.duration = Number.isFinite(duration) ? duration : null;
      state.seekTarget = state.currentTime;
      const packedDimensions = Number(width || 0) * 0x1_0000_0000 + Number(height || 0);
      const mediaFormat = state.contentType || String(await state.input.getFormat().catch(() => 'unknown'));
      sendEvent(state, EVENT.metadata, state.duration ?? 0, packedDimensions, textEncoder.encode(mediaFormat));
      if (state.duration !== null) sendEvent(state, EVENT.duration, state.duration);
      state.hasVideo = Boolean(videoTrack);
      state.hasAudio = Boolean(audioTrack);
      state.trackCount = Number(Boolean(videoTrack)) + Number(Boolean(audioTrack));
      if (videoTrack) void playVideo(state, new VideoSampleSink(videoTrack));
      if (audioTrack) void playAudio(state, new AudioSampleSink(audioTrack));
      emitState(state);
    } catch (error) {
      if (!state.closed) fail(state, error);
    }
  }

  function makePlayer(id, value, callbacks) {
    if (activePlayers >= MAX_PLAYERS) return null;
    const flags = Number(value) >>> 0;
    const transform = new TransformStream(undefined,
      { highWaterMark: 1024 * 1024, size: (chunk) => chunk.byteLength },
      { highWaterMark: 1, size: (chunk) => chunk.byteLength });
    const source = new ReadableStreamSource(transform.readable, {
      maxCacheSize: SOURCE_CACHE_BYTES,
      handleUnhandledError: (error) => {
        const state = players.get(id);
        if (state) fail(state, error);
      },
    });
    const state = {
      id, callbacks, input: new Input({ formats: ALL_FORMATS, source }),
      writer: transform.writable.getWriter(), contentType: '', pendingBytes: 0,
      backpressured: false, inputEnded: false, closed: false, failed: false,
      playing: false, muted: false, volume: 1, rate: 1, currentTime: 0,
      baseTime: 0, playStartedAt: 0, seekable: false, seekTarget: 0,
      duration: null, hasVideo: Boolean(flags & 1), hasAudio: false,
      audioViaServo: Boolean(flags & 2), trackCount: 0, tracksDone: 0,
      prerollTracksReady: 0, prerollStateSent: false, hasPrerolledVideo: false,
      waiters: [], initPromise: null,
    };
    players.set(id, state);
    activePlayers++;
    return state;
  }

  function command({ operation, playerId, value, bytes }, callbacks) {
    if (operation === OP.create) return makePlayer(playerId, value, callbacks) ? 0 : 2;
    const state = players.get(playerId);
    if (!state) return operation === OP.destroy ? 0 : 2;
    switch (operation) {
      case OP.contentType:
        state.contentType = textDecoder.decode(bytes).slice(0, 512);
        return 0;
      case OP.push: {
        if (state.closed || state.inputEnded || state.failed) return 2;
        if (state.pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) {
          state.backpressured = true;
          return 1;
        }
        state.pendingBytes += bytes.byteLength;
        if (!state.initPromise) state.initPromise = initialize(state);
        state.writer.write(bytes).then(() => {
          state.pendingBytes = Math.max(0, state.pendingBytes - bytes.byteLength);
          if (state.backpressured && state.pendingBytes <= RESUME_PENDING_BYTES) {
            state.backpressured = false;
            sendEvent(state, EVENT.needData);
          }
        }, (error) => {
          state.pendingBytes = Math.max(0, state.pendingBytes - bytes.byteLength);
          if (!state.closed) fail(state, error);
        });
        emit({ type: 'media-activity', playerId });
        return 0;
      }
      case OP.end:
        if (!state.inputEnded) {
          state.inputEnded = true;
          state.writer.close().catch((error) => { if (!state.closed) fail(state, error); });
          if (!state.initPromise) state.initPromise = initialize(state);
        }
        emit({ type: 'media-activity', playerId });
        return 0;
      case OP.play:
        if (state.failed || state.inputEnded && state.tracksDone === state.trackCount) return 0;
        state.baseTime = state.currentTime;
        state.playStartedAt = performance.now();
        state.playing = true;
        notify(state);
        sendEvent(state, EVENT.state, 1);
        emitState(state);
        return 0;
      case OP.pause:
      case OP.stop:
        state.currentTime = operation === OP.stop ? 0 : updatePosition(state);
        state.baseTime = state.currentTime;
        state.playing = false;
        state.seekTarget = state.currentTime;
        notify(state);
        sendEvent(state, EVENT.state, 0);
        emitState(state);
        return 0;
      case OP.seek:
        if (!state.seekable || !Number.isFinite(value) || value < state.currentTime) return 2;
        state.currentTime = value;
        state.seekTarget = value;
        state.baseTime = value;
        state.playStartedAt = performance.now();
        sendEvent(state, EVENT.position, value);
        return 0;
      case OP.muted:
        state.muted = Boolean(value);
        return 0;
      case OP.volume:
        state.volume = Math.max(0, Math.min(1, Number(value)));
        return 0;
      case OP.rate:
        if (!Number.isFinite(value) || value <= 0) return 2;
        state.currentTime = updatePosition(state);
        state.baseTime = state.currentTime;
        state.playStartedAt = performance.now();
        state.rate = value;
        return 0;
      case OP.seekable:
        state.seekable = Boolean(value);
        return 0;
      case OP.destroy:
        state.closed = true;
        state.playing = false;
        notify(state);
        players.delete(playerId);
        activePlayers = Math.max(0, activePlayers - 1);
        state.writer.abort().catch(() => {});
        state.input.dispose();
        emit({ type: 'media-state', playerId, playing: false, hasVideo: state.hasVideo, hasAudio: state.hasAudio });
        return 0;
      case OP.inputSize:
      case OP.buffering:
        return 0;
      default:
        return 2;
    }
  }

  return {
    command,
    dispose() {
      for (const id of [...players.keys()]) command({ operation: OP.destroy, playerId: id }, {});
    },
  };
}
