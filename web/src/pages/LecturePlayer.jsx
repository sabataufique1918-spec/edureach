import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, mediaUrl } from '../lib/api.js';
import { get, put } from '../lib/db.js';
import downloads from '../lib/downloads.js';
import { duration, mb, MODE_LABEL } from '../lib/format.js';
import { isOffPeak } from '../lib/net.js';
import ModePicker from '../components/ModePicker.jsx';
import Spinner, { ErrorNote } from '../components/Spinner.jsx';

export default function LecturePlayer({ net, user }) {
  const { lectureId } = useParams();
  const [manifest, setManifest] = useState(null);
  const [mode, setMode] = useState(user.preferredMode || 'audio');
  const [localUrl, setLocalUrl] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [slides, setSlides] = useState(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const mediaRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cached = await get('lectures', lectureId);
      if (cached && !cancelled) setManifest(cached);
      try {
        const fresh = await api.lectureManifest(lectureId, net.kbps);
        if (cancelled) return;
        setManifest(fresh);
        setMode(fresh.recommendedMode || 'audio');
        await put('lectures', { ...fresh, courseId: fresh.courseId });
      } catch (err) {
        if (!cached) setError(err);
      }
    })();

    return () => { cancelled = true; };
  }, [lectureId, net.kbps]);

  useEffect(() => downloads.onDownloadProgress((event) => {
    if (event.lectureId === lectureId) setProgress(event);
  }), [lectureId]);

  // Prefer the copy on the device. This is what lets a lecture play with the
  // aeroplane mode switch on.
  useEffect(() => {
    let revoked = null;
    (async () => {
      const url = await downloads.getBlobUrl(lectureId, mode);
      setLocalUrl(url);
      revoked = url;
      if (url && mode === 'slides') {
        const text = await (await fetch(url)).text();
        setSlides(JSON.parse(text));
      }
    })();
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [lectureId, mode, progress?.complete]);

  const option = manifest?.options?.find((o) => o.mode === mode);

  async function startDownload() {
    if (!option) return;
    setError(null);
    try {
      await downloads.download(manifest, mode, option);
      const check = await downloads.verifyDownload(lectureId, mode);
      if (!check.ok) setError(new Error(check.reason));
    } catch (err) {
      setError(err);
    }
  }

  if (!manifest) return error ? <ErrorNote error={error} /> : <Spinner />;

  const bigDownload = option && option.bytes > 80 * 1048576;

  return (
    <>
      <h1>{manifest.title}</h1>
      <p className="muted">{duration(manifest.durationSec)}</p>

      <ErrorNote error={error} />

      {localUrl && mode !== 'slides' && (
        <div className="card">
          <div className="banner info">Playing the copy saved on this device.</div>
          {mode === 'audio' ? (
            <audio ref={mediaRef} src={localUrl} controls style={{ width: '100%' }} />
          ) : (
            <video ref={mediaRef} src={localUrl} controls playsInline style={{ width: '100%' }} />
          )}
        </div>
      )}

      {localUrl && mode === 'slides' && slides && (
        <div className="card">
          <div className="slide-stage">
            <img
              src={mediaUrl(
                `/media/slide/${lectureId}/${slides.slides[slideIndex]?.key.split('/').pop()}`
              )}
              alt={`Slide ${slideIndex + 1}`}
              loading="lazy"
            />
          </div>
          <div className="row between" style={{ marginTop: 8 }}>
            <button className="sm" onClick={() => setSlideIndex(Math.max(0, slideIndex - 1))}>
              Previous
            </button>
            <span className="muted">
              Slide {slideIndex + 1} of {slides.count}
            </span>
            <button
              className="sm"
              onClick={() => setSlideIndex(Math.min(slides.count - 1, slideIndex + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Choose how much data to spend</h3>
        <ModePicker
          options={manifest.options}
          value={mode}
          recommended={manifest.recommendedMode}
          onChange={setMode}
        />
      </div>

      {option && !localUrl && (
        <div className="card">
          {bigDownload && !isOffPeak() && (
            <div className="banner warn">
              {MODE_LABEL[mode]} is {mb(option.bytes)}. Downloading between 1am
              and 6am is usually faster and cheaper.
            </div>
          )}

          {progress && !progress.complete && (
            <div className="stack" style={{ marginBottom: 10 }}>
              <div className="progress">
                <span style={{ width: `${progress.percent || 0}%` }} />
              </div>
              <div className="muted">
                {progress.percent || 0}% · {mb(progress.receivedBytes || 0)} of{' '}
                {mb(progress.totalBytes || option.bytes)}
                {progress.paused && ' · paused, will resume where it stopped'}
              </div>
            </div>
          )}

          <div className="row">
            <button className="primary" onClick={startDownload} disabled={net.quality === 'offline'}>
              {progress && !progress.complete ? 'Resume download' : `Download ${mb(option.bytes)}`}
            </button>
            {progress && !progress.complete && (
              <button className="ghost" onClick={() => downloads.cancelDownload(lectureId, mode)}>
                Pause
              </button>
            )}
          </div>

          {option.streamUrl && net.quality === 'good' && (
            <p className="muted" style={{ marginTop: 10 }}>
              You can also stream this without saving it, but nothing will be
              kept for offline use.
            </p>
          )}
        </div>
      )}

      {localUrl && (
        <button
          className="danger"
          onClick={async () => {
            await downloads.deleteDownload(lectureId, mode);
            setLocalUrl(null);
          }}
        >
          Delete the saved copy
        </button>
      )}
    </>
  );
}
