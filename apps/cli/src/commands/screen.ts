import { CHAIN_IDS, ChainIdSchema, isValidAddress } from "@fot/core";
import { globalsOf, type parseCli } from "../args.ts";
import { boot, type CliIo, UsageError } from "../io.ts";
import { EXIT_OK } from "./shared.ts";

export async function screenCommand(
  parsed: ReturnType<typeof parseCli>,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parsed;
  const chain = ChainIdSchema.safeParse(values.chain);
  if (!chain.success) throw new UsageError(`--chain must be one of ${CHAIN_IDS.join(", ")}`);
  const address = positionals[1];
  if (!address || positionals.length > 2)
    throw new UsageError("usage: fot screen --chain <id> <address>");
  if (!isValidAddress(chain.data, address)) {
    throw new UsageError(`not a valid ${chain.data} address: ${address}`);
  }
  const { db, runtime } = await boot(globalsOf(values), io);
  try {
    const labels = runtime.labels.lookup(chain.data, address);
    const lines = [
      `Address:   ${address}`,
      `Chain:     ${chain.data}`,
      `Sanctioned (OFAC SDN): ${runtime.labels.isSanctioned(chain.data, address) ? "YES" : "no"}`,
      "Labels:",
      ...(labels.length === 0
        ? ["  none"]
        : labels.map((l) => {
            const entity = l.entity && l.entity !== l.name ? `, ${l.entity}` : "";
            const programs = l.programs?.length ? ` programs ${l.programs.join(", ")}` : "";
            return `  ${l.name} (${l.category}${entity}) [${l.origin}]${programs} ${l.source}`;
          })),
    ];
    await io.stdout(`${lines.join("\n")}\n`);
    return EXIT_OK;
  } finally {
    db.close();
  }
}
