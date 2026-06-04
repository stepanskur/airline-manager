// storage.js — thin wrapper over chrome.storage.local

export async function getAll() {
  return new Promise((resolve) => chrome.storage.local.get(null, resolve));
}

export async function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

export async function set(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
}

export async function getKey(key, fallback) {
  const out = await get([key]);
  return key in out ? out[key] : fallback;
}

export async function setKey(key, value) {
  return set({ [key]: value });
}

export async function remove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
}
