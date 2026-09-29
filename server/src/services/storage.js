import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import env from '../config/env.js';
import log from '../utils/logger.js';

// MinIO in a pilot, S3 in production. Identical API, so the deployment picks
// whichever is cheaper without touching this file.
export const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  forcePathStyle: env.s3.forcePathStyle,
  credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
});

export async function putObject(key, body, contentType, extra = {}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Derived media never changes once written, so clients and the nginx
      // tier can cache it for a year and skip the revalidation round-trip.
      CacheControl: extra.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      ...extra.meta ? { Metadata: extra.meta } : {},
    })
  );
  return key;
}

export async function putFile(key, filePath, contentType, extra = {}) {
  const stream = fs.createReadStream(filePath);
  return putObject(key, stream, contentType, extra);
}

export async function getObjectStream(key, range) {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.s3.bucket, Key: key, ...(range ? { Range: range } : {}) })
  );
  return {
    body: res.Body instanceof Readable ? res.Body : Readable.from(res.Body),
    contentLength: res.ContentLength,
    contentType: res.ContentType,
    contentRange: res.ContentRange,
    etag: res.ETag,
  };
}

export async function headObject(key) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return { exists: true, size: res.ContentLength, contentType: res.ContentType, etag: res.ETag };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return { exists: false };
    throw err;
  }
}

export async function deletePrefix(prefix) {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: env.s3.bucket, Prefix: prefix })
  );
  for (const obj of listed.Contents || []) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: obj.Key }));
  }
  return (listed.Contents || []).length;
}

// Short-lived direct link. Used only when the client is on a good connection;
// otherwise downloads go through the API so they can be range-resumed and
// metered against the data budget.
export function signedUrl(key, seconds = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }), {
    expiresIn: seconds,
  });
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export async function ensureBucketReachable() {
  try {
    await s3.send(new ListObjectsV2Command({ Bucket: env.s3.bucket, MaxKeys: 1 }));
    log.info(`object storage ready: ${env.s3.bucket}`);
    return true;
  } catch (err) {
    log.warn(`object storage unreachable (${err.message}) - media routes will fail until it is up`);
    return false;
  }
}

export default {
  putObject,
  putFile,
  getObjectStream,
  headObject,
  deletePrefix,
  signedUrl,
  sha256File,
  ensureBucketReachable,
};
