export type Selection =
  | { kind: "edge"; edgeId: string }
  | { kind: "address"; address: string }
  | { kind: "pair"; from: string; to: string }
  | { kind: "set"; addresses: string[]; edgeIds: string[]; title: string };
