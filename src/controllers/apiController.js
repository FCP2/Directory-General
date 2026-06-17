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
  };
}

