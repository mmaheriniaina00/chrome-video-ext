// Turns a Blob stored in IndexedDB into a blob: URL (not possible in a service worker).
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vd-blobs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function takeBlob(key) {
  const db = await openDb();
  const blob = await new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    const store = tx.objectStore('blobs');
    const get = store.get(key);
    get.onsuccess = () => { store.delete(key); resolve(get.result); };
    get.onerror = () => reject(get.error);
  });
  db.close();
  return blob;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.action !== 'makeBlobUrl') return;
  takeBlob(msg.key)
    .then((blob) => {
      if (!blob) throw new Error('Blob not found');
      sendResponse({ url: URL.createObjectURL(blob) });
    })
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});
