/**
 * Compile the Chat Assistant modules (src/lib/chat/*.ts) to temp ESM with
 * tsc, then run node:test. Same approach as scripts/test-front-desk.mjs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src/lib/chat");
const workDir = join(root, ".tmp-chat-test");
const compileSrc = join(workDir, "src");
const outDir = join(workDir, "out");

rmSync(workDir, { recursive: true, force: true });
mkdirSync(compileSrc, { recursive: true });
mkdirSync(outDir, { recursive: true });

for (const name of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
  const code = readFileSync(join(srcDir, name), "utf8").replace(/from "(\.\/[^"]+)\.ts"/g, 'from "$1.js"');
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
        lib: ["ES2022", "DOM"],
        types: ["node"],
        typeRoots: [join(root, "node_modules/@types")],
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        rootDir: compileSrc,
        outDir,
        noEmit: false,
      },
      include: [join(compileSrc, "**/*.ts")],
    },
    null,
    2,
  ),
);

const tsc = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", cfgPath], { cwd: root, encoding: "utf8" });
if (tsc.status !== 0) {
  console.error(tsc.stdout);
  console.error(tsc.stderr);
  process.exit(tsc.status ?? 1);
}

const testJs = join(outDir, "chat.test.js");
if (!existsSync(testJs)) {
  console.error("compiled test missing:", testJs);
  process.exit(1);
}
const run = spawnSync(process.execPath, ["--test", testJs], { cwd: root, encoding: "utf8", env: process.env });
process.stdout.write(run.stdout || "");
process.stderr.write(run.stderr || "");
process.exit(run.status ?? 1);
