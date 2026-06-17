import dotenv from "dotenv";

dotenv.config();

export const PORT = process.env.PORT || 3000;
export const SHEET_ID = process.env.SHEET_ID;
export const STATIC_DIR = process.env.STATIC_DIR || "public";
export const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

