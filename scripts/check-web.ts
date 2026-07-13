import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dir, "..", "web", "app.js"), "utf8");
const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
transpiler.transformSync(source);
console.log("Browser JavaScript parsed successfully.");
