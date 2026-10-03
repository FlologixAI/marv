import { Static } from "ink";
import type { Message } from "../types.ts";
import { MessageView } from "./MessageView.tsx";
import { Welcome } from "./Welcome.tsx";

export type TranscriptItem = { kind: "welcome"; id: string } | { kind: "message"; id: string; message: Message };

interface Props {
  items: TranscriptItem[];
  version: string;
  cwd: string;
}

// <Static> prints each item exactly once, above the live UI, and then forgets
// about it. Finished messages become ordinary terminal scrollback instead of
// being re-rendered on every keystroke, so a long session stays fast.
export function Transcript({ items, version, cwd }: Props) {
  return (
    <Static items={items}>
      {(item) =>
        item.kind === "welcome" ? (
          <Welcome key={item.id} version={version} cwd={cwd} />
        ) : (
          <MessageView key={item.id} message={item.message} />
        )
      }
    </Static>
  );
}
