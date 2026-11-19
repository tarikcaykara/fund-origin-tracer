// Imports OKX's proof-of-reserves addresses on Arbitrum and Polygon into the bundled label files.
// Pass one "Reserves" file from https://www.okx.com/proof-of-reserves/download, from the
// repository root (needs `unzip`), then commit the label files:
//   bun scripts/okx-por.ts https://static.okx.com/cdn/okx/por/chain/por_csv_2026110100_V1.zip
// Every row is verified by its signature before it becomes a label, and entries from earlier
// snapshots are kept (packages/core/src/labels/okx-por.ts).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBundledLabelFile } from "../packages/core/src/labels/files.ts";
import {
  mergeOkxPor,
  OKX_POR_NETWORKS,
  OKX_POR_SNAPSHOT_URL_RE,
  readOkxPor,
} from "../packages/core/src/labels/okx-por.ts";

/** Lines of a byte stream, without their `\n` or `\r\n`. */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    rest = lines.pop() ?? "";
    yield* lines;
  }
  rest += decoder.decode();
  if (rest !== "") yield rest;
}

const url = process.argv[2] ?? "";
if (!OKX_POR_SNAPSHOT_URL_RE.test(url)) {
  throw new Error("usage: bun scripts/okx-por.ts <OKX reserves snapshot zip URL>");
}

const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
// A zip is read from its end, so it cannot be streamed to `unzip`.
const dir = await mkdtemp(join(tmpdir(), "okx-por-"));
try {
  const zip = join(dir, "snapshot.zip");
  await Bun.write(zip, res);
  const unzip = Bun.spawn(["unzip", "-p", zip], { stdout: "pipe", stderr: "inherit" });
  const found = await readOkxPor(linesOf(unzip.stdout));
  if ((await unzip.exited) !== 0) throw new Error(`unzip exited with ${unzip.exitCode}`);

  // Merge every chain before writing any file, so a refused entry leaves all files unchanged.
  const verifiedAt = new Date().toISOString().slice(0, 10);
  const merges = [];
  for (const chain of new Set(Object.values(OKX_POR_NETWORKS))) {
    const path = `packages/core/labels/${chain}.json`;
    const file = parseBundledLabelFile(await Bun.file(path).json());
    const merged = mergeOkxPor(file, found, url, verifiedAt);
    // The same check the server runs when it loads the bundled files.
    parseBundledLabelFile(merged.file);
    merges.push({ chain, path, merged });
  }
  for (const { chain, path, merged } of merges) {
    await Bun.write(path, `${JSON.stringify(merged.file, null, 2)}\n`);
    console.log(
      `${chain}: ${merged.added} added, ${merged.updated} updated, ${merged.kept.length} kept (labeled from another source)`,
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
