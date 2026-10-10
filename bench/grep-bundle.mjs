#!/usr/bin/env node
// grep-bundle.mjs <file> <regex> [before=200] [after=800] [max=5]
import { readFileSync } from "node:fs";
const [file, pat, b = 200, a = 800, max = 5] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const re = new RegExp(pat, "g");
let m, n = 0;
while ((m = re.exec(src)) && n++ < Number(max)) {
  console.log(`--- @${m.index}`);
  console.log(src.slice(Math.max(0, m.index - Number(b)), m.index + Number(a)));
}
