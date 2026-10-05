import { memo, useCallback, type ReactNode } from "react";
import { Box, type DOMElement } from "ink";
import type { Message } from "../types.ts";
import { MessageView } from "./MessageView.tsx";
import { Welcome } from "./Welcome.tsx";

export type TranscriptItem = { kind: "welcome"; id: string } | { kind: "message"; id: string; message: Message };

interface Props {
  items: TranscriptItem[];
  version: string;
  cwd: string;
  /** Whether an AGENTS.md was loaded (shown in the welcome banner). */
  instructions?: boolean;
  /** How many skills were found. */
  skills?: number;
  /** How many memories were loaded. */
  memories?: number;
  /** ctrl+o: show subagents' steps under their entries. */
  showSteps?: boolean;
  /** Told where each subagent's entry is drawn (null when it goes), so a click can find it. Keep it stable (memo). */
  onAgentRef?: (id: string, element: DOMElement | null) => void;
}

/** A subagent's entry, in a box whose layout says which transcript rows it covers (its parent is the scrolled content). */
function AgentEntry({ id, onRef, children }: { id: string; onRef: (id: string, element: DOMElement | null) => void; children: ReactNode }) {
  const ref = useCallback((element: DOMElement | null) => onRef(id, element), [id, onRef]);
  return (
    <Box ref={ref} flexDirection="column">
      {children}
    </Box>
  );
}

/** The id of the subagent entry covering a transcript row, from the layout Ink last drew. */
export function agentEntryAt(row: number, entries: Map<string, DOMElement>): string | null {
  for (const [id, element] of entries) {
    const layout = element.yogaNode?.getComputedLayout();
    if (layout && row >= layout.top && row < layout.top + layout.height) return id;
  }
  return null;
}

// In the alternate screen every frame is redrawn from the React tree, so the
// whole transcript stays mounted (inside a ScrollView) instead of being printed
// once with <Static>. memo() skips re-rendering it on every keystroke.
export const Transcript = memo(function Transcript({ items, version, cwd, instructions, skills, memories, showSteps, onAgentRef }: Props) {
  return items.map((item) => {
    if (item.kind === "welcome") {
      return <Welcome key={item.id} version={version} cwd={cwd} instructions={instructions} skills={skills} memories={memories} />;
    }
    // Only entries with steps get the flag, so ctrl+o re-renders just those.
    const view = <MessageView key={item.id} message={item.message} showSteps={item.message.tool?.steps ? showSteps : false} />;
    return item.message.role === "tool" && item.message.text === "agent" && onAgentRef ? (
      <AgentEntry key={item.id} id={item.id} onRef={onAgentRef}>
        {view}
      </AgentEntry>
    ) : (
      view
    );
  });
});
