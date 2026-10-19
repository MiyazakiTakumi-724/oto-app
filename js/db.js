// IndexedDB に曲(音声データ込み)とプレイリストを保存する
const DB_NAME = 'oto';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        // 音声本体は別ストアに分け、一覧表示で大きなデータを読まないようにする
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(tx)).then((r) => { result = r; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getAllTracks() {
  return run(['tracks'], 'readonly', (tx) => req2p(tx.objectStore('tracks').getAll()));
}

export async function putTrack(track, blob) {
  return run(['tracks', 'blobs'], 'readwrite', (tx) => {
    tx.objectStore('tracks').put(track);
    if (blob) tx.objectStore('blobs').put(blob, track.id);
  });
}

export async function getBlob(id) {
  return run(['blobs'], 'readonly', (tx) => req2p(tx.objectStore('blobs').get(id)));
}

export async function deleteTrack(id) {
  return run(['tracks', 'blobs', 'playlists'], 'readwrite', async (tx) => {
    tx.objectStore('tracks').delete(id);
    tx.objectStore('blobs').delete(id);
    const pls = tx.objectStore('playlists');
    const all = await req2p(pls.getAll());
    for (const pl of all) {
      if (pl.trackIds.includes(id)) {
        pl.trackIds = pl.trackIds.filter((t) => t !== id);
        pls.put(pl);
      }
    }
  });
}

export async function getAllPlaylists() {
  return run(['playlists'], 'readonly', (tx) => req2p(tx.objectStore('playlists').getAll()));
}

export async function putPlaylist(pl) {
  return run(['playlists'], 'readwrite', (tx) => { tx.objectStore('playlists').put(pl); });
}

export async function deletePlaylist(id) {
  return run(['playlists'], 'readwrite', (tx) => { tx.objectStore('playlists').delete(id); });
}
