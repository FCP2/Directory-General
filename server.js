import express from "express";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import { ALLOWED_ORIGINS, PORT, SHEET_ID, STATIC_DIR } from "./src/config/env.js";
import { createApiRouter } from "./src/routes/apiRoutes.js";

const app = express();
const rootPath = path.resolve();
const staticPath = path.join(rootPath, STATIC_DIR);

if (!fs.existsSync(staticPath)) {
  fs.mkdirSync(staticPath, { recursive: true });
}

app.use(morgan("dev"));
app.use(compression());
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

app.use(createApiRouter({ staticPath }));
app.use(express.static(staticPath, { extensions: ["html"] }));

app.get("*", (req, res, next) => {
  const indexFile = path.join(staticPath, "index.html");
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

app.listen(PORT, () => {
  console.log(`Server listo en http://localhost:${PORT}`);
  if (!SHEET_ID) {
    console.warn("No configuraste SHEET_ID. Los endpoints de Sheets responderan 400.");
  }
});

