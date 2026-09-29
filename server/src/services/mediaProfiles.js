// The encoding ladder. Every number here comes straight from the bandwidth
// budget in the design document, and is the single place to tune it.
//
// The ordering matters: the client is offered modes cheapest-first, and the
// default for a new student is "audio", not "low".

export const PROFILES = {
  // ~24 kbps mono Opus. One hour of lecture lands at roughly 10 MB.
  audio: {
    mode: 'audio',
    kind: 'audio',
    label: 'Audio only',
    bitrateKbps: 24,
    estMbPerHour: 10.5,
    container: 'webm',
    args: [
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ac', '1',
      '-ar', '24000',
      '-application', 'voip',
      // Variable bitrate with a hard ceiling keeps silence cheap without
      // letting a noisy classroom blow past the budget.
      '-vbr', 'on',
      '-compression_level', '10',
    ],
  },

  // Slide images plus the audio track. Visuals cost a few KB every time the
  // teacher advances a slide, instead of 15 frames a second forever.
  slides: {
    mode: 'slides',
    kind: 'slides',
    label: 'Slides + audio',
    bitrateKbps: 50,
    estMbPerHour: 22,
    container: 'webm',
    sceneChangeThreshold: 0.25,
    slideWidth: 960,
    slideQuality: 62,
  },

  low: {
    mode: 'low',
    kind: 'video',
    label: 'Video 144p',
    bitrateKbps: 200,
    estMbPerHour: 90,
    container: 'mp4',
    height: 144,
    fps: 15,
    args: [
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-preset', 'veryfast',
      '-b:v', '176k',
      '-maxrate', '200k',
      '-bufsize', '400k',
      '-g', '30',
      '-sc_threshold', '0',
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ac', '1',
    ],
  },

  medium: {
    mode: 'medium',
    kind: 'video',
    label: 'Video 240p',
    bitrateKbps: 400,
    estMbPerHour: 180,
    container: 'mp4',
    height: 240,
    fps: 20,
    args: [
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-preset', 'veryfast',
      '-b:v', '368k',
      '-maxrate', '400k',
      '-bufsize', '800k',
      '-g', '40',
      '-sc_threshold', '0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
    ],
  },

  // Generated on request only. Never the default, and the UI warns before use.
  high: {
    mode: 'high',
    kind: 'video',
    label: 'Video 480p',
    bitrateKbps: 900,
    estMbPerHour: 400,
    container: 'mp4',
    height: 480,
    fps: 25,
    args: [
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-preset', 'veryfast',
      '-b:v', '836k',
      '-maxrate', '900k',
      '-bufsize', '1800k',
      '-g', '50',
      '-sc_threshold', '0',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ac', '2',
    ],
  },
};

// What gets built for every upload without being asked. "high" is opt-in
// because it costs more to store than the other four combined.
export const DEFAULT_LADDER = ['audio', 'slides', 'low', 'medium'];

export const MODE_ORDER = ['audio', 'slides', 'low', 'medium', 'high'];

// HLS segments are short so that a dropped connection loses at most four
// seconds of buffered data rather than a ten-second chunk.
export const HLS_SEGMENT_SEC = 4;

export function estimateBytes(mode, durationSec) {
  const profile = PROFILES[mode];
  if (!profile) return 0;
  return Math.round((profile.bitrateKbps * 1000 * durationSec) / 8);
}

// Picks the richest mode that fits the measured downlink, with headroom so a
// student is not pinned to the exact edge of what the link can carry.
export function recommendMode(measuredKbps) {
  if (!measuredKbps || measuredKbps <= 0) return 'audio';
  const usable = measuredKbps * 0.7;
  if (usable >= PROFILES.high.bitrateKbps) return 'high';
  if (usable >= PROFILES.medium.bitrateKbps) return 'medium';
  if (usable >= PROFILES.low.bitrateKbps) return 'low';
  if (usable >= PROFILES.slides.bitrateKbps) return 'slides';
  return 'audio';
}

export default { PROFILES, DEFAULT_LADDER, MODE_ORDER, HLS_SEGMENT_SEC, estimateBytes, recommendMode };
