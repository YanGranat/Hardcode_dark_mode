import fs from "node:fs";
import vm from "node:vm";

export const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
export const clone = value => JSON.parse(JSON.stringify(value));
export function load(context, ...files) {
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
  return context;
}
