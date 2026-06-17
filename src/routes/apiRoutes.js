import { Router } from "express";
import { createApiController } from "../controllers/apiController.js";

export function createApiRouter(deps) {
  const router = Router();
  const controller = createApiController(deps);

  router.get("/health", controller.health);
  router.get("/api/sheets", controller.listSheets);
  router.get("/api/data/:tab", controller.getSheetData);
  router.get("/api/data-all", controller.getAllSheetData);
  router.get("/api/municipios", controller.getMunicipios);

  return router;
}

