export type Selection =
  | { kind: "edge"; edgeId: string }
  | { kind: "address"; address: string }
  | { kind: "pair"; from: string; to: string }
  | { kind: "set"; addresses: string[]; edgeIds: string[]; title: string };

/** Stable identity of a selection: changes exactly when a different thing is selected. */
export function selectionKey(selection: Selection | null): string {
  if (selection === null) return "none";
  switch (selection.kind) {
    case "edge":
      return `edge:${selection.edgeId}`;
    case "address":
      return `address:${selection.address}`;
    case "pair":
      return `pair:${selection.from}:${selection.to}`;
    case "set":
      return `set:${selection.title}:${selection.addresses.join(",")}:${selection.edgeIds.join(",")}`;
  }
}
