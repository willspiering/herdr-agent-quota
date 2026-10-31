import { readFile, writeFile, mkdir, readdir, rm, access } from "node:fs/promises";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const exists = async path => access(path).then(() => true, () => false);
// Herdr writes jsconfig.json and .d.ts files itself; they are not part of a build.
const buildFile = name => !name.startsWith(".") && name !== "jsconfig.json" && !name.endsWith(".d.ts");
// Stage changed files beside the target, then move them all in with no await in between: one
// uninterrupted run of atomic renames, so Herdr reloads once and never sees a mixed build.
export async function swapBuild(source, target, staging, remove) {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    const moves = [];
    for (const name of (await readdir(source, { withFileTypes: true })).filter(e => e.isFile() && buildFile(e.name)).map(e => e.name)) {
      const next = await readFile(join(source, name));
      const current = await readFile(join(target, name)).catch(() => null);
      if (current && current.equals(next)) continue;
      await writeFile(join(staging, name), next);
      moves.push(name);
    }
    const stale = [];
    for (const name of remove) if (await exists(join(target, name))) stale.push(name);
    // No awaits from here: the swap is one uninterrupted run of renames.
    for (const name of moves) renameSync(join(staging, name), join(target, name));
    for (const name of stale) rmSync(join(target, name), { force: true });
    return moves.length + stale.length;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

