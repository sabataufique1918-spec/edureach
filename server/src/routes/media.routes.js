import express from 'express';
import { Lecture } from '../models/index.js';
import { requireMediaAuth } from '../middleware/auth.js';
import { wrap } from '../middleware/error.js';
import { recordUsage } from '../middleware/dataMeter.js';
import { getObjectStream, headObject } from '../services/storage.js';

const router = express.Router();

// Media is served through the API rather than by a signed object-store URL so
// that byte accounting, integrity headers, and access control all apply. The
// nginx tier in front caches the result, so this costs one origin fetch per
// object per institute, not per student.

// Streams an object with full HTTP Range support. Range is what makes a
// download resumable after the connection drops mid-lecture.
// Object storage being down is a dependency outage, not a server fault. It is
// reported as 503 with a retry hint so the client pauses and resumes the
// download later, rather than treating the lecture as broken and giving up.
function storageUnavailable(res, err) {
  return res.status(503).json({
    error: 'media storage is temporarily unavailable',
    retry: true,
    detail: err.message,
  });
}

const isConnectionError = (err) =>
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
    `${err.name} ${err.message} ${err.code || ''}`
  );

async function streamObject(req, res, key, contentType, mode) {
  let head;
  try {
    head = await headObject(key);
  } catch (err) {
    if (isConnectionError(err)) return storageUnavailable(res, err);
    throw err;
  }
  if (!head.exists) return res.status(404).json({ error: 'media object not found' });

  const range = req.headers.range;
  const type = contentType || head.contentType || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (head.etag) res.setHeader('ETag', head.etag);

  // Nothing changed since the client last saw it: answer in ~200 bytes.
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === head.etag) {
    return res.status(304).end();
  }

  let obj;
  try {
    obj = await getObjectStream(key, range);
  } catch (err) {
    if (isConnectionError(err)) return storageUnavailable(res, err);
    throw err;
  }
  if (range && obj.contentRange) {
    res.status(206);
    res.setHeader('Content-Range', obj.contentRange);
  }
  if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);

  let sent = 0;
  obj.body.on('data', (chunk) => { sent += chunk.length; });
  // Metered on close rather than on finish, so a download aborted halfway
  // still counts the bytes that actually crossed the link.
  res.on('close', () => recordUsage(req.auth?.sub, sent, mode || 'media'));

  obj.body.on('error', () => res.destroy());
  return obj.body.pipe(res);
}

router.use(requireMediaAuth);

// Whole-file download for the offline library.
router.get(
  '/file/:lectureId/:mode',
  wrap(async (req, res) => {
    const lecture = await Lecture.findById(req.params.lectureId);
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });

    const rendition = lecture.rendition(req.params.mode);
    if (!rendition) {
      return res.status(404).json({
        error: `mode "${req.params.mode}" is not available for this lecture`,
        available: lecture.renditions.filter((r) => r.ready).map((r) => r.mode),
      });
    }

    const contentType =
      rendition.kind === 'audio' ? 'audio/webm'
        : rendition.kind === 'slides' ? 'application/json'
          : 'video/mp4';

    // Lets the client verify the file before playing it, so a truncated
    // download is detected on the device rather than mid-lecture.
    if (rendition.sha256) res.setHeader('X-Content-SHA256', rendition.sha256);
    res.setHeader('X-Content-Mode', rendition.mode);

    return streamObject(req, res, rendition.key, contentType, rendition.mode);
  })
);

// HLS playlist and segments, for playback that starts before the whole file
// has arrived.
router.get(
  '/hls/:lectureId/:mode/:file',
  wrap(async (req, res) => {
    const { lectureId, mode, file } = req.params;
    if (!/^[\w.-]+$/.test(file)) return res.status(400).json({ error: 'invalid segment name' });

    const lecture = await Lecture.findById(lectureId);
    if (!lecture) return res.status(404).json({ error: 'lecture not found' });

    const rendition = lecture.rendition(mode);
    if (!rendition || !rendition.playlistKey) {
      return res.status(404).json({ error: `no stream available for mode "${mode}"` });
    }

    const prefix = rendition.playlistKey.replace(/\/[^/]+$/, '');

    // A playlist lists its segments as relative names. If the client
    // authenticated with a query token, the player would request those
    // segments without it and get a 401 partway through the lecture, so the
    // token is stamped onto each segment line. Playlists are a few KB, so
    // buffering one to rewrite it is cheap.
    if (file.endsWith('.m3u8')) {
      let obj;
      try {
        obj = await getObjectStream(`${prefix}/${file}`);
      } catch (err) {
        if (isConnectionError(err)) return storageUnavailable(res, err);
        throw err;
      }
      const chunks = [];
      for await (const chunk of obj.body) chunks.push(chunk);
      let playlist = Buffer.concat(chunks).toString('utf8');

      if (req.query.t) {
        const token = encodeURIComponent(String(req.query.t));
        playlist = playlist
          .split('\n')
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            return `${trimmed}${trimmed.includes('?') ? '&' : '?'}t=${token}`;
          })
          .join('\n');
      }

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      // Not immutable: the rewritten body depends on the caller token.
      res.setHeader('Cache-Control', 'private, max-age=60');
      recordUsage(req.auth?.sub, Buffer.byteLength(playlist), mode);
      return res.send(playlist);
    }

    return streamObject(req, res, `${prefix}/${file}`, 'video/mp2t', mode);
  })
);

// Individual slide images, fetched lazily as the student pages through.
router.get(
  '/slide/:lectureId/:file',
  wrap(async (req, res) => {
    const { lectureId, file } = req.params;
    if (!/^[\w.-]+\.(webp|json)$/.test(file)) {
      return res.status(400).json({ error: 'invalid slide name' });
    }
    return streamObject(req, res, `lectures/${lectureId}/slides/${file}`, undefined, 'slides');
  })
);

export default router;
