import crypto from "crypto";
import { CACHE_TTL_MS } from "../config/env.js";

const cache = new Map();

export function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

export function setCache(key, data, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { expiresAt: Date.now() + ttlMs, data });
}

export function cacheKey(parts) {
  return crypto.createHash("md5").update(parts.join("|")).digest("hex");
}

