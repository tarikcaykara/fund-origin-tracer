import { z } from "zod";
import { CHAINS, EVM_ADDRESS_RE, TRON_ADDRESS_RE } from "../chains.ts";
import { ChainIdSchema, LabelCategorySchema } from "../schema.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVM_LOWER_RE = /^0x[0-9a-f]{40}$/;

function addressValid(chain: z.infer<typeof ChainIdSchema>, address: string, strictCase: boolean) {
  if (CHAINS[chain].kind === "tron") return TRON_ADDRESS_RE.test(address);
  return (strictCase ? EVM_LOWER_RE : EVM_ADDRESS_RE).test(address);
}

export const BundledLabelEntrySchema = z.object({
  address: z.string(),
  name: z.string().min(1),
  category: LabelCategorySchema,
  entity: z.string().min(1).optional(),
  source: z.url(),
  verifiedAt: z.string().regex(DATE_RE, "expected YYYY-MM-DD"),
});
export type BundledLabelEntry = z.infer<typeof BundledLabelEntrySchema>;

export const BundledLabelFileSchema = z
  .object({
    chain: ChainIdSchema,
    entries: z.array(BundledLabelEntrySchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.entries.forEach((e, i) => {
      if (!addressValid(file.chain, e.address, true)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "address"],
          message:
            CHAINS[file.chain].kind === "evm"
              ? "EVM address must be lowercase 0x + 40 hex"
              : "invalid TRON address",
        });
        return;
      }
      if (seen.has(e.address)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "address"],
          message: `duplicate address ${e.address}`,
        });
      }
      seen.add(e.address);
    });
  });
export type BundledLabelFile = z.infer<typeof BundledLabelFileSchema>;

export const LocalLabelEntrySchema = z
  .object({
    chain: ChainIdSchema,
    address: z.string(),
    name: z.string().min(1),
    category: LabelCategorySchema,
    entity: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (!addressValid(e.chain, e.address, false)) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "invalid address for chain" });
    }
  });
export type LocalLabelEntry = z.infer<typeof LocalLabelEntrySchema>;

export const LocalLabelFileSchema = z.object({ entries: z.array(LocalLabelEntrySchema) });
export type LocalLabelFile = z.infer<typeof LocalLabelFileSchema>;

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseBundledLabelFile(json: unknown): BundledLabelFile {
  const r = BundledLabelFileSchema.safeParse(json);
  if (!r.success) throw new Error(`Invalid bundled label file: ${describe(r.error)}`);
  return r.data;
}

export function parseLocalLabelFile(json: unknown): LocalLabelFile {
  const r = LocalLabelFileSchema.safeParse(json);
  if (!r.success) throw new Error(`Invalid local label file: ${describe(r.error)}`);
  return r.data;
}

export function labelsVersion(files: readonly BundledLabelFile[]): string {
  let max = "";
  for (const f of files) for (const e of f.entries) if (e.verifiedAt > max) max = e.verifiedAt;
  return max;
}
