import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function version() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0+unknown";
  } catch {
    return "0+unknown";
  }
}
