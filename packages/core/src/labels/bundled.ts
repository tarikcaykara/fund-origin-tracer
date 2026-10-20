import arbitrum from "../../labels/arbitrum.json" with { type: "json" };
import ethereum from "../../labels/ethereum.json" with { type: "json" };
import polygon from "../../labels/polygon.json" with { type: "json" };
import tron from "../../labels/tron.json" with { type: "json" };
import { type BundledLabelFile, parseBundledLabelFile } from "./files.ts";

export const BUNDLED_LABEL_FILES: BundledLabelFile[] = [ethereum, polygon, arbitrum, tron].map(
  (f) => parseBundledLabelFile(f),
);
