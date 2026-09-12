/**
 * Compile FE-2 front-desk TS → temp ESM, then run node:test.
 * Node 20 in this sandbox lacks --experimental-strip-types (Node 22+).
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src/lib/whatsapp");
const workDir = join(root, ".tmp-fe2-test");
const compileSrc = join(workDir, "src");
const outDir = join(workDir, "out");

rmSync(workDir, { recursive: true, force: true });
mkdirSync(compileSrc, { recursive: true });
mkdirSync(outDir, { recursive: true });

for (const name of ["front-desk.ts", "front-desk.test.ts", "send.ts"]) {
  const src = join(srcDir, name);
  if (!existsSync(src)) continue;
  let code = readFileSync(src, "utf8");
  code = code.replaceAll('from "./front-desk.ts"', 'from "./front-desk.js"');
  code = code.replaceAll('from "./send.ts"', 'from "./send.js"');
  writeFileSync(join(compileSrc, name), code);
}

const cfgPath = join(workDir, "tsconfig.json");
writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        rootDir: compileSrc,
        outDir,
        declaration: false,
        noEmit: false,
      },
      include: [join(compileSrc, "**/*.ts")],
    },
    null,
    2,
  ),
);

const tsc = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", cfgPath], {
  cwd: root,
  encoding: "utf8",
});
if (tsc.status !== 0) {
  console.error(tsc.stdout);
  console.error(tsc.stderr);
  process.exit(tsc.status ?? 1);
}

const testJs = join(outDir, "front-desk.test.js");
if (!existsSync(testJs)) {
  console.error("compiled test missing:", testJs);
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", testJs], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(run.stdout || "");
process.stderr.write(run.stderr || "");
process.exit(run.status ?? 1);
