import { memo } from "react";
import type { Message } from "../types.ts";
import { MessageView } from "./MessageView.tsx";
import { Welcome } from "./Welcome.tsx";

export type TranscriptItem = { kind: "welcome"; id: string } | { kind: "message"; id: string; message: Message };

interface Props {
  items: TranscriptItem[];
  version: string;
  cwd: string;
}

// In the alternate screen every frame is redrawn from the React tree, so the
// whole transcript stays mounted (inside a ScrollView) instead of being printed
// once with <Static>. memo() skips re-rendering it on every keystroke.
export const Transcript = memo(function Transcript({ items, version, cwd }: Props) {
  return items.map((item) =>
    item.kind === "welcome" ? (
      <Welcome key={item.id} version={version} cwd={cwd} />
    ) : (
      <MessageView key={item.id} message={item.message} />
    ),
  );
});
