import { build } from "esbuild";

await build({
  entryPoints: ["src/app.js"],
  outfile: "public/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  sourcemap: false,
  minify: false,
  legalComments: "none"
});

console.log("前端应用已打包");
