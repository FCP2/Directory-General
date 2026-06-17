import { google } from "googleapis";
import { SHEET_ID } from "../config/env.js";
import { cacheKey, getCache, setCache } from "./cacheService.js";

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
      throw new Error("Credenciales BASE64 invalidas");
    }
  }

  return new google.auth.GoogleAuth({
    credentials: credentialsObj || undefined,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function getSheetsApi() {
  const auth = getGoogleAuth();
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

export async function listSheetTabs() {
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

export async function readSheetToJson(tabName) {
  const key = cacheKey(["data", SHEET_ID, tabName]);
  const cached = getCache(key);
  if (cached) return cached;

  const sheets = await getSheetsApi();
  const range = `'${tabName}'`;
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

