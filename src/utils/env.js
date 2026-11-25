import path from "node:path";
import { config as loadEnvFile } from "dotenv";

// Loaded once, before any module reads process.env at call time.
loadEnvFile({ path: path.join(process.cwd(), ".env") });
