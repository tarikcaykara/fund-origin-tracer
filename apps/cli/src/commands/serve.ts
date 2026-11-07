import { loadConfig, startServer } from "@fot/server";
import { globalsOf, type parseCli } from "../args.ts";
import { type CliIo, UsageError } from "../io.ts";
import { EXIT_OK } from "./shared.ts";

export async function serveCommand(
  parsed: ReturnType<typeof parseCli>,
  io: CliIo,
): Promise<number> {
  const { values } = parsed;
  const g = globalsOf(values);
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new UsageError("--port must be 0-65535");
  }
  const config = loadConfig(io.env, {
    dataDir: g.dataDir,
    labelsPath: g.labels,
    policyPath: g.policy,
    port,
  });
  const server = await startServer(config);
  for (const w of server.runtime.bootWarnings) io.stderr(`warning: ${w.code}: ${w.message}\n`);
  // IPv6 literals need brackets in a URL.
  const host =
    config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  io.stderr(`fund-origin-tracer listening on http://${host}:${server.port}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.stop();
  return EXIT_OK;
}
