import mongoose from 'mongoose';
import env from './env.js';
import log from '../utils/logger.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 20,
  });
  log.info(`mongo connected: ${mongoose.connection.name}`);
  return mongoose.connection;
}

export default connectMongo;
