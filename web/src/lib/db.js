import { openDB } from 'idb';

// On-device store. Everything a student needs to keep studying with no signal
// lives here: lecture manifests, quiz payloads, discussion threads, downloaded
// media blobs, and the outbox of unsent work.

const DB_NAME = 'edureach';
const DB_VERSION = 1;

export const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('courses')) {
      db.createObjectStore('courses', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('lectures')) {
      const store = db.createObjectStore('lectures', { keyPath: 'id' });
      store.createIndex('courseId', 'courseId');
    }
    if (!db.objectStoreNames.contains('quizzes')) {
      const store = db.createObjectStore('quizzes', { keyPath: 'id' });
      store.createIndex('courseId', 'courseId');
    }
    if (!db.objectStoreNames.contains('attempts')) {
      db.createObjectStore('attempts', { keyPath: 'quizId' });
    }
    if (!db.objectStoreNames.contains('discussion')) {
      const store = db.createObjectStore('discussion', { keyPath: 'id' });
      store.createIndex('courseId', 'courseId');
      store.createIndex('seq', 'seq');
    }
    if (!db.objectStoreNames.contains('downloads')) {
      // Downloaded media, keyed by lectureId:mode.
      db.createObjectStore('downloads', { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains('outbox')) {
      const store = db.createObjectStore('outbox', { keyPath: 'clientOpId' });
      store.createIndex('createdAt', 'createdAt');
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta', { keyPath: 'key' });
    }
  },
});

export async function putAll(storeName, records) {
  const db = await dbPromise;
  const tx = db.transaction(storeName, 'readwrite');
  await Promise.all(records.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function getAll(storeName, indexName, value) {
  const db = await dbPromise;
  if (indexName && value !== undefined) {
    return db.getAllFromIndex(storeName, indexName, value);
  }
  return db.getAll(storeName);
}

export async function get(storeName, key) {
  return (await dbPromise).get(storeName, key);
}

export async function put(storeName, record) {
  return (await dbPromise).put(storeName, record);
}

export async function remove(storeName, key) {
  return (await dbPromise).delete(storeName, key);
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// Rough size of what is stored on the device, for the storage line in the
// offline library.
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return {
    usedMb: Number((usage / 1048576).toFixed(1)),
    quotaMb: Number((quota / 1048576).toFixed(1)),
  };
}

// Wipes everything belonging to the signed-in student. Called on sign-out,
// because these devices are shared: a phone in a village campus is routinely
// passed between students, and the next one must not find someone else's
// lectures, marks or certificates on it.
//
// The outbox is deliberately included, so callers must drain or explicitly
// discard it first.
export async function clearUserData() {
  const db = await dbPromise;
  const stores = ['courses', 'lectures', 'quizzes', 'attempts', 'discussion', 'downloads', 'outbox', 'meta'];
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  await tx.done;

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_PRIVATE' });
  }
}

export default {
  dbPromise,
  putAll,
  getAll,
  get,
  put,
  remove,
  getMeta,
  setMeta,
  storageEstimate,
  clearUserData,
};
