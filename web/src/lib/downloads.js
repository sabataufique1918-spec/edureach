import { get, put, remove, getAll } from './db.js';
import { getToken } from './api.js';

// Resumable download manager.
//
// Large files are fetched in ranged chunks and stored as blobs in IndexedDB.
// If the link dies at 80%, the next attempt resumes at 80% instead of starting
// over - which on a 2G connection is the difference between a lecture that
// eventually arrives and one that never does.

const CHUNK_BYTES = 512 * 1024;
const listeners = new Set();

export function onDownloadProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  listeners.forEach((fn) => fn(event));
}

const key = (lectureId, mode) => `${lectureId}:${mode}`;

export async function isDownloaded(lectureId, mode) {
  const row = await get('downloads', key(lectureId, mode));
  return Boolean(row && row.complete);
}

export async function listDownloads() {
  const rows = await getAll('downloads');
  return rows.map((r) => ({
    key: r.key,
    lectureId: r.lectureId,
    mode: r.mode,
    title: r.title,
    complete: r.complete,
    receivedBytes: r.receivedBytes,
    totalBytes: r.totalBytes,
    mb: Number((r.receivedBytes / 1048576).toFixed(2)),
    savedAt: r.savedAt,
  }));
}

export async function getBlobUrl(lectureId, mode) {
  const row = await get('downloads', key(lectureId, mode));
  if (!row || !row.complete) return null;
  return URL.createObjectURL(new Blob(row.chunks, { type: row.contentType }));
}

const aborters = new Map();

export function cancelDownload(lectureId, mode) {
  aborters.get(key(lectureId, mode))?.abort();
}

export async function download(lecture, mode, option) {
  const id = key(lecture.id, mode);
  const url = `/media/file/${lecture.id}/${mode}`;

  let row = (await get('downloads', id)) || {
    key: id,
    lectureId: lecture.id,
    mode,
    title: lecture.title,
    chunks: [],
    receivedBytes: 0,
    totalBytes: option?.bytes || 0,
    contentType: '',
    sha256: option?.sha256 || '',
    complete: false,
    savedAt: null,
  };

  if (row.complete) return row;

  const controller = new AbortController();
  aborters.set(id, controller);

  try {
    while (!row.complete) {
      const start = row.receivedBytes;
      const end = row.totalBytes
        ? Math.min(start + CHUNK_BYTES - 1, row.totalBytes - 1)
        : start + CHUNK_BYTES - 1;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${getToken()}`,
          Range: `bytes=${start}-${end}`,
        },
        signal: controller.signal,
      });

      if (response.status === 416) {
        // Requested past the end: the file is already fully here.
        row.complete = true;
        break;
      }
      if (!response.ok && response.status !== 206 && response.status !== 200) {
        throw new Error(`download failed with ${response.status}`);
      }

      // Content-Range tells us the true size, which is authoritative over the
      // manifest estimate.
      const contentRange = response.headers.get('Content-Range');
      if (contentRange) {
        const total = Number(contentRange.split('/')[1]);
        if (Number.isFinite(total)) row.totalBytes = total;
      }
      row.contentType = response.headers.get('Content-Type') || row.contentType;

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        row.complete = true;
        break;
      }

      row.chunks.push(buffer);
      row.receivedBytes += buffer.byteLength;
      if (row.totalBytes && row.receivedBytes >= row.totalBytes) row.complete = true;

      // Persist after every chunk: a browser that is killed mid-download loses
      // at most 512 KB of progress.
      await put('downloads', row);
      emit({
        lectureId: lecture.id,
        mode,
        receivedBytes: row.receivedBytes,
        totalBytes: row.totalBytes,
        percent: row.totalBytes ? Math.round((row.receivedBytes / row.totalBytes) * 100) : 0,
        complete: row.complete,
      });
    }

    row.savedAt = Date.now();
    await put('downloads', row);
    emit({ lectureId: lecture.id, mode, percent: 100, complete: true });
    return row;
  } catch (err) {
    // Progress is already persisted, so the partial download survives for the
    // next attempt.
    emit({ lectureId: lecture.id, mode, error: err.message, paused: true });
    throw err;
  } finally {
    aborters.delete(id);
  }
}

export async function deleteDownload(lectureId, mode) {
  await remove('downloads', key(lectureId, mode));
}


// Integrity check against the hash in the manifest. A download that arrived
// corrupted over a flaky link is caught here, on the device, rather than
// halfway through playback.
export async function verifyDownload(lectureId, mode) {
  const row = await get('downloads', key(lectureId, mode));
  if (!row || !row.complete) return { ok: false, reason: 'not downloaded' };
  if (!row.sha256) return { ok: true, reason: 'no hash published for this file' };

  const blob = new Blob(row.chunks);
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (hex !== row.sha256) {
    // A corrupted file is worse than a missing one: drop it so the next
    // attempt starts clean.
    await remove('downloads', row.key);
    return { ok: false, reason: 'checksum mismatch, the file was removed' };
  }
  return { ok: true, reason: 'checksum verified' };
}

export default {
  download,
  verifyDownload,
  cancelDownload,
  deleteDownload,
  listDownloads,
  isDownloaded,
  getBlobUrl,
  onDownloadProgress,
};
