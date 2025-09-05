// server.js
// Servidor Express para servir HTML/municipios.json y leer varias hojas de Google Sheets

import express from "express";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { google } from "googleapis";
import process from "process";
import crypto from "crypto";

dotenv.config();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID; // ID del Google Sheet (obligatorio)
const STATIC_DIR = process.env.STATIC_DIR || "public"; // carpeta con index.html y municipios.json
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 min por default

// CORS dinámico
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Helpers ----------
const app = express();
app.use(morgan("dev"));
app.use(compression());

// CORS: si no configuras ALLOWED_ORIGINS, permite todo en local; en Render, pon tu dominio
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.length === 0) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolver ruta estática
const __dirnameResolved = path.resolve();
const staticPath = path.join(__dirnameResolved, STATIC_DIR);

// Asegura que exista la carpeta estática en local (no es obligatorio en Render si solo sirves API)
if (!fs.existsSync(staticPath)) {
  fs.mkdirSync(staticPath, { recursive: true });
}

// ---------- Autenticación Google Sheets ----------
/**
 * Las credenciales se pueden proporcionar de 2 formas:
 * 1) Archivo local con GOOGLE_APPLICATION_CREDENTIALS apuntando al .json
 * 2) Variable GOOGLE_CREDENTIALS_BASE64 con el contenido del .json en Base64 (ideal para Render)
 */
function getGoogleAuth() {
  let credentialsObj = null;

  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
      const jsonStr = Buffer.from(
        process.env.GOOGLE_CREDENTIALS_BASE64,
        "base64"
      ).toString("utf8");
      credentialsObj = JSON.parse(jsonStr);
    } catch (e) {
      console.error("Error parseando GOOGLE_CREDENTIALS_BASE64:", e.message);
      throw new Error("Credenciales BASE64 inválidas");
    }
  }

  // Si no hay BASE64, GoogleAuth intentará usar GOOGLE_APPLICATION_CREDENTIALS o ADC
  const auth = new google.auth.GoogleAuth({
    credentials: credentialsObj || undefined,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return auth;
}

async function getSheetsApi() {
  const auth = getGoogleAuth();
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// ---------- Caché simple en memoria ----------
const cache = new Map(); // key -> { expiresAt: number, data: any }
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.data;
}
function setCache(key, data, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { expiresAt: Date.now() + ttlMs, data });
}
function cacheKey(parts) {
  return crypto.createHash("md5").update(parts.join("|")).digest("hex");
}

// ---------- Utilidades Sheets ----------
/**
 * Obtiene la lista de hojas (tabs) del spreadsheet
 */
async function listSheetTabs() {
  const key = cacheKey(["tabs", SHEET_ID]);
  const cached = getCache(key);
  if (cached) return cached;

  const sheets = await getSheetsApi();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    includeGridData: false,
  });

  const tabs =
    meta.data.sheets?.map((s) => s.properties?.title).filter(Boolean) || [];

  setCache(key, tabs);
  return tabs;
}

/**
 * Lee una hoja completa a objetos JSON.
 * - Si la primera fila son encabezados, se usan como claves.
 * - Si no, genera columnas "Col1", "Col2", ...
 */
async function readSheetToJson(tabName) {
  const key = cacheKey(["data", SHEET_ID, tabName]);
  const cached = getCache(key);
  if (cached) return cached;

  const sheets = await getSheetsApi();
  const range = `'${tabName}'`; // hoja completa
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    const empty = { tab: tabName, headers: [], rows: [] };
    setCache(key, empty);
    return empty;
  }

  const headers = rows[0].map((h) => (h || "").trim());
  const body = rows.slice(1);

  // Si hay headers no vacíos, mapea como objetos; si no, regresa arrays
  const hasHeaders = headers.some((h) => h.length > 0);
  let data;

  if (hasHeaders) {
    data = body.map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h || `Col${i + 1}`] = row[i] ?? "";
      });
      return obj;
    });
  } else {
    // No hay encabezados: usa Col1, Col2, ...
    const maxLen = Math.max(...rows.map((r) => r.length));
    const genHeaders = Array.from({ length: maxLen }, (_, i) => `Col${i + 1}`);
    data = body.map((row) => {
      const obj = {};
      genHeaders.forEach((h, i) => {
        obj[h] = row[i] ?? "";
      });
      return obj;
    });
  }

  const result = { tab: tabName, headers, rows: data };
  setCache(key, result);
  return result;
}

// ---------- Rutas API ----------
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Lista nombres de hojas
app.get("/api/sheets", async (_req, res) => {
  try {
    if (!SHEET_ID) {
      return res
        .status(400)
        .json({ error: "Falta configurar SHEET_ID en variables de entorno." });
    }
    const tabs = await listSheetTabs();
    res.json({ sheetId: SHEET_ID, tabs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo obtener la lista de hojas" });
  }
});

// Devuelve datos de una hoja específica como JSON
app.get("/api/data/:tab", async (req, res) => {
  const tab = req.params.tab;
  try {
    if (!SHEET_ID) {
      return res
        .status(400)
        .json({ error: "Falta configurar SHEET_ID en variables de entorno." });
    }
    const tabs = await listSheetTabs();
    if (!tabs.includes(tab)) {
      return res.status(404).json({
        error: `La hoja '${tab}' no existe. Hojas disponibles: ${tabs.join(
          ", "
        )}`,
      });
    }
    const data = await readSheetToJson(tab);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `No se pudo leer la hoja '${tab}'` });
  }
});

// Endpoint opcional para traer todas las hojas (cuidado con performance si son muchas)
app.get("/api/data-all", async (_req, res) => {
  try {
    if (!SHEET_ID) {
      return res
        .status(400)
        .json({ error: "Falta configurar SHEET_ID en variables de entorno." });
    }
    const tabs = await listSheetTabs();
    const payload = {};
    for (const t of tabs) {
      payload[t] = await readSheetToJson(t);
    }
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudieron leer las hojas" });
  }
});

// ---------- Archivos estáticos (index.html, municipios.json, etc.) ----------
app.use(express.static(staticPath, { extensions: ["html"] }));

// Si quieres un endpoint directo para municipios.json además de servirlo como estático:
app.get("/api/municipios", (req, res) => {
  const file = path.join(staticPath, "municipios.json");
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "municipios.json no encontrado" });
  }
  res.sendFile(file);
});

// Fallback al index.html (para SPA)
app.get("*", (req, res, next) => {
  const indexFile = path.join(staticPath, "index.html");
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log(`✅ Server listo en http://localhost:${PORT}`);
  if (!SHEET_ID) {
    console.warn(
      "⚠️  No configuraste SHEET_ID. Los endpoints de Sheets responderán 400."
    );
  }
});