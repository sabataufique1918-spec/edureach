import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import env from './config/env.js';
import { notFound, errorHandler } from './middleware/error.js';
import { meterResponse } from './middleware/dataMeter.js';

import authRoutes from './routes/auth.routes.js';
import courseRoutes from './routes/courses.routes.js';
import lectureRoutes from './routes/lectures.routes.js';
import mediaRoutes from './routes/media.routes.js';
import interactionRoutes from './routes/interactions.routes.js';
import syncRoutes from './routes/sync.routes.js';
import sessionRoutes from './routes/sessions.routes.js';
import credentialRoutes from './routes/credentials.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import healthRoutes from './routes/health.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The PWA and the media tier are served from different origins in a
      // split deployment, so the strict cross-origin default would break them.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    })
  );
  app.use(
    cors({
      origin: true,
      credentials: true,
      // Without these the browser hides them from JavaScript on a
      // cross-origin deployment, and the download manager relies on
      // Content-Range to resume and on the hash header to verify.
      exposedHeaders: [
        'Content-Range',
        'Content-Length',
        'Accept-Ranges',
        'X-Content-SHA256',
        'X-Content-Mode',
        'X-From-Cache',
      ],
    })
  );

  // Compress JSON aggressively; skip media, which is already compressed and
  // would only burn server CPU for nothing.
  app.use(
    compression({
      threshold: 512,
      filter: (req, res) => {
        const type = res.getHeader('Content-Type') || '';
        if (/^(video|audio|image)\//.test(String(type))) return false;
        return compression.filter(req, res);
      },
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(meterResponse);

  // Media requests carry the auth token in the query string, because an <img>
  // tag cannot set a header. Without this, every access log line would contain
  // a usable credential.
  morgan.token('url', (req) =>
    (req.originalUrl || req.url).replace(/([?&])t=[^&]*/g, '$1t=REDACTED')
  );

  if (env.nodeEnv !== 'test') {
    app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
  }

  // Auth is the only endpoint worth rate limiting hard; everything else is
  // already gated by a token.
  app.use(
    '/api/auth',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false })
  );

  // API responses must never sit in the browser HTTP cache. Without an
  // explicit directive, Chrome applies heuristic caching to any 200 that
  // carries a Last-Modified or ETag, which is how a stale JSON banner can
  // keep being shown at "/" long after the server stopped serving one.
  //
  // This does not affect offline support: the service worker stores API
  // responses in the Cache API deliberately, which is separate storage.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/courses', courseRoutes);
  app.use('/api/lectures', lectureRoutes);
  app.use('/api/interactions', interactionRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/credentials', credentialRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/health', healthRoutes);

  // Media sits outside /api so the nginx cache rule can target it cleanly.
  app.use('/media', mediaRoutes);

  // Machine-readable service banner, moved off "/" so the root can serve the
  // app itself.
  app.get('/api', (req, res) =>
    res.json({
      service: 'EduReach API',
      version: '1.0.0',
      health: '/api/health/ready',
      verifyCredential: '/api/credentials/verify',
    })
  );

  // ---------------------------------------------------------------------
  // The web client, served from the same origin as the API.
  //
  // One origin means no CORS preflight on any request, and the media token
  // never has to cross an origin boundary. It also means a student types one
  // address and gets the app, which is the only thing they should ever need
  // to know. nginx still fronts this in production; this is what it proxies.
  // ---------------------------------------------------------------------
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(here, '../../web/dist');
  const hasClient = fs.existsSync(path.join(clientDir, 'index.html'));

  if (hasClient) {
    app.use(
      express.static(clientDir, {
        // Vite fingerprints asset filenames, so they can be cached forever.
        // index.html must not be, or a deployed fix would never reach anyone.
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (/\/assets\//.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    // Client-side routing: any non-API path that is not a real file is the
    // app, not a 404. /api and /media are excluded so a genuine bad API call
    // still returns JSON rather than an HTML page.
    app.get(/^(?!\/(?:api|media)(?:\/|$)).*/, (req, res, next) => {
      if (req.method !== 'GET' || req.accepts('html') !== 'html') return next();
      return res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    app.get('/', (req, res) =>
      res.status(200).json({
        service: 'EduReach API',
        note: 'The web client has not been built yet, so only the API is available here.',
        buildIt: 'cd web && npm install && npm run build',
        orDevServer: 'cd web && npm run dev',
        health: '/api/health/ready',
      })
    );
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export default createApp;
