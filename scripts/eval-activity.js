import { readFileSync } from "node:fs";
import { CONFIG } from "../web/config.js";
import { crossSessionEval, evalMarkdown } from "../web/activity.js";

const path = new URL("../web/model/activity-data.json", import.meta.url);
let data;
try {
  data = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error("No web/model/activity-data.json yet. Record with Label mode on the page, export, and save it there.");
  process.exit(1);
}

const runs = crossSessionEval(data, CONFIG);
if (runs.length === 0) {
  console.error("Need windows from both session 1 and session 2.");
  process.exit(1);
}
console.log(evalMarkdown(runs));
