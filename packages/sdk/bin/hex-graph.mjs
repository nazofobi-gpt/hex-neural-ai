#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { validateGraphJson, MAX_GRAPH_JSON_CHARS } from "../dist/index.js";

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const [action, file, ...extra] = process.argv.slice(2);
if (action !== "validate" || !file || extra.length) {
  process.stderr.write("Usage: hex-graph validate <graph.json>\n");
  process.exitCode = 2;
} else {
  try {
    const size = (await stat(file)).size;
    // Read bound: UTF-8 worst-case bytes are at least the ASCII char count.
    if (size > MAX_GRAPH_JSON_CHARS * 4) {
      output({ valid: false, issues: [{ code: "INPUT_TOO_LARGE", message: "Graph file exceeds safe input size." }] });
      process.exitCode = 1;
    } else {
      const result = validateGraphJson(await readFile(file, "utf8"));
      output(result);
      process.exitCode = result.valid ? 0 : 1;
    }
  } catch {
    output({ valid: false, issues: [{ code: "FILE_UNAVAILABLE", message: "Graph file could not be read." }] });
    process.exitCode = 2;
  }
}
