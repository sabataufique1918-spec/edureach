import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import env from '../config/env.js';
import log from '../utils/logger.js';
import { PROFILES, HLS_SEGMENT_SEC } from './mediaProfiles.js';
import { putFile, getObjectStream, sha256File } from './storage.js';

// ffmpeg wrapper. Everything the compression tier does lives here: one source
// upload in, an Opus track, a slide deck, and an H.264 ladder out.

function run(bin, args, { timeoutMs = 45 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // ffmpeg is extremely chatty; keep only the tail for diagnostics.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${bin} failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

// ffprobe reports on stdout, so it needs its own runner.
export function probe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.media.ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`ffprobe failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-500)}`));
      resolve(parseProbe(stdout));
    });
  });
}

function parseProbe(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { durationSec: 0, hasVideo: false, hasAudio: false, width: 0, height: 0 };
  }
  const streams = json.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    durationSec: Math.round(Number(json.format?.duration || 0)),
    sizeBytes: Number(json.format?.size || 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
  };
}

export async function makeWorkDir(prefix = 'edureach') {
  const base = path.resolve(env.media.workDir || os.tmpdir());
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, `${prefix}-`));
}

export async function downloadToFile(key, destPath) {
  const { body } = await getObjectStream(key);
  await new Promise((resolve, reject) => {
    const out = fsSync.createWriteStream(destPath);
    body.pipe(out);
    body.on('error', reject);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return destPath;
}

// ---------------------------------------------------------------------------
// Rendition builders. Each returns { key, bytes, sha256, playlistKey }.
// ---------------------------------------------------------------------------

// Audio-only: the mode that has to work on a 2G link, so it is built first
// and marked ready before any video work starts.
export async function buildAudio(srcPath, workDir, lectureId) {
  const profile = PROFILES.audio;
  const outPath = path.join(workDir, 'audio.webm');
  await run(env.media.ffmpeg, [
    '-y', '-i', srcPath,
    ...profile.args,
    // Trim leading and trailing silence: dead air at the start of a recording
    // is pure wasted download for every student.
    '-af', 'silenceremove=start_periods=1:start_silence=0.5:start_threshold=-45dB',
    outPath,
  ]);

  const key = `lectures/${lectureId}/audio/audio.webm`;
  const [{ size }, sha256] = await Promise.all([fs.stat(outPath), sha256File(outPath)]);
  await putFile(key, outPath, 'audio/webm', { immutable: true });
  return { key, bytes: size, sha256, bitrateKbps: profile.bitrateKbps, playlistKey: '' };
}

// Slides mode: detect scene changes, write each as a WebP, and ship a small
// JSON index of { index, timeSec, key }. A whole lecture of slides is usually
// smaller than ten seconds of 144p video.
export async function buildSlides(srcPath, workDir, lectureId, probeInfo) {
  const profile = PROFILES.slides;
  if (!probeInfo.hasVideo) return null;

  const slideDir = path.join(workDir, 'slides');
  await fs.mkdir(slideDir, { recursive: true });

  await run(env.media.ffmpeg, [
    '-y', '-i', srcPath,
    '-vf',
    `select=gt(scene\,${profile.sceneChangeThreshold}),scale=${profile.slideWidth}:-2`,
    '-vsync', 'vfr',
    '-c:v', 'libwebp',
    '-quality', String(profile.slideQuality),
    '-compression_level', '6',
    '-frames:v', '400',
    path.join(slideDir, 'slide-%04d.webp'),
  ]);

  const files = (await fs.readdir(slideDir)).filter((f) => f.endsWith('.webp')).sort();
  if (files.length === 0) return null;

  // Even spacing is a deliberate approximation: exact timestamps would need a
  // second ffmpeg pass, and the player only needs them to seek roughly right.
  const spacing = probeInfo.durationSec / files.length;
  const slides = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += 1) {
    const filePath = path.join(slideDir, files[i]);
    const key = `lectures/${lectureId}/slides/${files[i]}`;
    const { size } = await fs.stat(filePath);
    totalBytes += size;
    await putFile(key, filePath, 'image/webp', { immutable: true });
    slides.push({ index: i, timeSec: Math.round(i * spacing), key, bytes: size });
  }

  const indexPath = path.join(workDir, 'slides.json');
  await fs.writeFile(indexPath, JSON.stringify({ count: slides.length, slides }), 'utf8');
  const indexKey = `lectures/${lectureId}/slides/index.json`;
  await putFile(indexKey, indexPath, 'application/json', { immutable: true });
  totalBytes += (await fs.stat(indexPath)).size;

  return {
    key: indexKey,
    bytes: totalBytes,
    sha256: await sha256File(indexPath),
    bitrateKbps: profile.bitrateKbps,
    playlistKey: '',
    slideCount: slides.length,
  };
}

// Video ladder. Produces both a progressive MP4 (for offline download, one
// file, resumable) and an HLS playlist (for live-ish playback with short
// segments). Rural clients almost always take the MP4.
export async function buildVideo(srcPath, workDir, lectureId, mode) {
  const profile = PROFILES[mode];
  if (!profile || profile.kind !== 'video') throw new Error(`not a video profile: ${mode}`);

  const outDir = path.join(workDir, mode);
  await fs.mkdir(outDir, { recursive: true });
  const mp4Path = path.join(outDir, `${mode}.mp4`);

  await run(env.media.ffmpeg, [
    '-y', '-i', srcPath,
    '-vf', `scale=-2:${profile.height}`,
    '-r', String(profile.fps),
    ...profile.args,
    // faststart moves the index to the front so playback can begin before the
    // file has fully arrived.
    '-movflags', '+faststart',
    mp4Path,
  ]);

  const key = `lectures/${lectureId}/${mode}/${mode}.mp4`;
  const [{ size }, sha256] = await Promise.all([fs.stat(mp4Path), sha256File(mp4Path)]);
  await putFile(key, mp4Path, 'video/mp4', { immutable: true });

  // Segment the already-encoded file rather than re-encoding it.
  const hlsDir = path.join(outDir, 'hls');
  await fs.mkdir(hlsDir, { recursive: true });
  await run(env.media.ffmpeg, [
    '-y', '-i', mp4Path,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SEC),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 'seg-%04d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ]);

  const hlsPrefix = `lectures/${lectureId}/${mode}/hls`;
  for (const file of await fs.readdir(hlsDir)) {
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    await putFile(`${hlsPrefix}/${file}`, path.join(hlsDir, file), type, { immutable: true });
  }

  return {
    key,
    bytes: size,
    sha256,
    bitrateKbps: profile.bitrateKbps,
    playlistKey: `${hlsPrefix}/index.m3u8`,
  };
}

// Full pipeline for one uploaded lecture. Renditions are committed to the
// database one at a time, so a failure at 240p still leaves students with a
// working audio version instead of nothing.
export async function processLecture(lecture, ladder, onRendition) {
  const workDir = await makeWorkDir(`lec-${lecture._id}`);
  try {
    const srcPath = path.join(workDir, 'source');
    await downloadToFile(lecture.sourceKey, srcPath);
    const info = await probe(srcPath);
    log.info(
      `lecture ${lecture._id}: ${info.durationSec}s ` +
        `video=${info.hasVideo} audio=${info.hasAudio}`
    );

    const results = [];
    for (const mode of ladder) {
      const profile = PROFILES[mode];
      if (!profile) continue;
      if (profile.kind !== 'audio' && !info.hasVideo) continue;
      if (profile.kind === 'audio' && !info.hasAudio) continue;

      try {
        let built = null;
        if (mode === 'audio') built = await buildAudio(srcPath, workDir, lecture._id);
        else if (mode === 'slides') built = await buildSlides(srcPath, workDir, lecture._id, info);
        else built = await buildVideo(srcPath, workDir, lecture._id, mode);

        if (!built) continue;
        const rendition = {
          mode,
          kind: profile.kind,
          durationSec: info.durationSec,
          ready: true,
          ...built,
        };
        results.push(rendition);
        if (onRendition) await onRendition(rendition, info);
        log.info(`lecture ${lecture._id}: ${mode} done (${(built.bytes / 1048576).toFixed(1)} MB)`);
      } catch (err) {
        log.error(`lecture ${lecture._id}: ${mode} failed - ${err.message}`);
      }
    }

    if (results.length === 0) throw new Error('no rendition could be produced from the source file');
    return { info, renditions: results };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default { probe, processLecture, buildAudio, buildSlides, buildVideo, makeWorkDir };
