import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });
dotenv.config();

const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',

  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',

  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/edureach',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'edureach-media',
    accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    publicUrl: process.env.S3_PUBLIC_URL || '',
  },

  media: {
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    workDir: process.env.MEDIA_WORK_DIR || './.media-work',
    concurrency: int(process.env.TRANSCODE_CONCURRENCY, 1),
  },

  fabric: {
    enabled: bool(process.env.FABRIC_ENABLED, false),
    channel: process.env.FABRIC_CHANNEL || 'edureachchannel',
    chaincode: process.env.FABRIC_CHAINCODE || 'edureach-cc',
    mspId: process.env.FABRIC_MSP_ID || 'Org1MSP',
    peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
    peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS || 'peer0.org1.edureach.local',
    tlsCertPath: process.env.FABRIC_TLS_CERT_PATH || '',
    certPath: process.env.FABRIC_CERT_PATH || '',
    keyPath: process.env.FABRIC_KEY_PATH || '',
  },

  analytics: {
    url: process.env.ANALYTICS_URL || 'http://localhost:8000',
    token: process.env.ANALYTICS_TOKEN || 'analytics-shared-secret',
  },
};

export default env;
