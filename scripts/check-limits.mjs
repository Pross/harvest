// Fails when a source file exceeds 300 lines or a function exceeds 30 lines.
// Heuristic (brace matching on top-level and nested function declarations / arrow functions); no dependencies.
import fs from "node:fs";
import path from "node:path";

const MAX_FILE = 300;
const MAX_FN = 30;
const root = path.resolve("src");
const problems = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|mjs)$/.test(e.name)) check(p);
  }
}

function check(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  if (lines.length > MAX_FILE) problems.push(`${file}: ${lines.length} lines (max ${MAX_FILE})`);
  const start = /(^|\s)(async\s+)?function\s*\*?\s*\w*\s*\(|=>\s*\{\s*$|^\s*(public |private |protected |static |async )*\w+\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (!start.test(lines[i]) || !lines[i].includes("{") || /^\s*(if|for|while|switch|catch)\b/.test(lines[i])) continue;
    let depth = 0, seen = false, j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === "{") { depth++; seen = true; } else if (ch === "}") depth--; }
      if (seen && depth <= 0) break;
    }
    const len = j - i + 1;
    if (len > MAX_FN) problems.push(`${file}:${i + 1}: function is ${len} lines (max ${MAX_FN})`);
  }
}

walk(root);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("limits ok");
