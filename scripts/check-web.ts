import { AssetStore } from "@sessionmap/cli/assets.ts";

const source = new AssetStore().get("app.js")?.body;
if (!source) throw new Error("Browser JavaScript bundle is unavailable.");
const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
transpiler.transformSync(source);
console.log("Browser JavaScript parsed successfully.");
