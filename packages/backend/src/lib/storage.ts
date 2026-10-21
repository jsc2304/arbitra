import { getStorage, type Storage } from 'firebase-admin/storage';
import { getFirebaseApp } from './firebase.js';

let storage: Storage;

export function getCloudStorage(): Storage {
  if (storage) return storage;
  storage = getStorage(getFirebaseApp());
  return storage;
}

export function getBucket() {
  return getCloudStorage().bucket();
}
