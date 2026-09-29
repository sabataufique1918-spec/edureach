// Single-process development stack.
//
// Starts an ephemeral MongoDB, seeds it, and boots the API against it. This
// exists so the app can be run and demonstrated on a machine without Docker,
// which is the normal situation on a college laptop. It is a development
// convenience only and is never used in a deployment.
//
// Redis and object storage are not started here. Both degrade by design: the
// API stays up, caching falls through to Mongo, and only media upload and
// playback are unavailable.

import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create({
  instance: { dbName: 'edureach' },
});

const uri = mongod.getUri('edureach');
process.env.MONGO_URI = uri;
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

console.log(`\n[sandbox] ephemeral MongoDB listening at ${uri}`);
console.log('[sandbox] data is discarded when this process exits\n');

// Imported only after MONGO_URI is set: config/env.js reads the environment
// at module load, so importing earlier would capture the wrong value.
const { connectMongo } = await import('../config/db.js');
const { initLedger } = await import('../services/ledger/index.js');

await connectMongo();
await initLedger();

if (process.env.SANDBOX_SEED !== 'false') {
  console.log('[sandbox] seeding demo data...');
  const { seedInto } = await import('./seed.js');
  await seedInto({ disconnect: false });
}

console.log('[sandbox] starting API...\n');
await import('../index.js');

const shutdown = async () => {
  await mongod.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
