import type { DocStatus } from "@shared/schema";

export interface LocalDoc {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
  thumbUrl: string | null;
  size: number;
  pages?: string;
  folderId: string | null;
  clientId?: string | null;
  status: DocStatus;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

const DB_NAME = "docera_db";
const STORE = "documents";
const DB_VERSION = 1;

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      resolve(_db!);
    };
    req.onerror = () => reject(req.error);
  });
}

function makeId(): string {
  return "local_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function listLocalDocs(): Promise<LocalDoc[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const docs = (req.result as LocalDoc[]).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      resolve(docs);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLocalDoc(id: string): Promise<LocalDoc | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as LocalDoc) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function createLocalDoc(
  doc: Omit<LocalDoc, "id" | "createdAt" | "updatedAt">
): Promise<LocalDoc> {
  const db = await openDb();
  const newDoc: LocalDoc = {
    ...doc,
    id: makeId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(newDoc);
    req.onsuccess = () => resolve(newDoc);
    req.onerror = () => reject(req.error);
  });
}

export async function updateLocalDoc(
  id: string,
  updates: Partial<Omit<LocalDoc, "id" | "createdAt">>
): Promise<LocalDoc | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as LocalDoc | undefined;
      if (!existing) { resolve(null); return; }
      const updated: LocalDoc = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function deleteLocalDoc(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
