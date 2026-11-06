import fs from "fs";
import path from "path";
import { SHEET_ID } from "../config/env.js";
import { listSheetTabs, readSheetToJson } from "../services/googleSheetsService.js";

export function createApiController({ staticPath }) {
  return {
    health(_req, res) {
      res.status(200).json({ ok: true, ts: Date.now() });
    },

    async listSheets(_req, res) {
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
    },

    async getSheetData(req, res) {
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
            error: `La hoja '${tab}' no existe. Hojas disponibles: ${tabs.join(", ")}`,
          });
        }
        const data = await readSheetToJson(tab);
        res.json(data);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: `No se pudo leer la hoja '${tab}'` });
      }
    },

    async getAllSheetData(_req, res) {
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
    },

    getMunicipios(_req, res) {
      const file = path.join(staticPath, "municipios.json");
      if (!fs.existsSync(file)) {
        return res.status(404).json({ error: "municipios.json no encontrado" });
      }
      res.sendFile(file);
    },
<<<<<<< HEAD

    async getPhoto(req, res) {
      const id = String(req.params.id || "");
      if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
        return res.status(400).json({ error: "ID de foto inválido" });
      }
      const sources = [
        `https://lh3.googleusercontent.com/d/${id}=w1000`,
        `https://lh3.googleusercontent.com/d/${id}`,
        `https://drive.google.com/thumbnail?id=${id}&sz=w1000`,
      ];
      try {
        for (const source of sources) {
          const response = await fetch(source, { redirect: "follow" });
          const contentType = response.headers.get("content-type") || "";
          if (!response.ok || !contentType.startsWith("image/")) continue;
          const image = Buffer.from(await response.arrayBuffer());
          res.set("Content-Type", contentType);
          res.set("Cache-Control", "public, max-age=86400");
          return res.send(image);
        }
        return res.status(404).json({ error: "No se pudo cargar la foto" });
      } catch (error) {
        console.error("Error cargando foto:", error.message);
        return res.status(502).json({ error: "No se pudo obtener la foto" });
      }
    },
=======
>>>>>>> origin/main
  };
}

