// Implicit feedback: what the user's next message says about the turn before
// it. A plain keyword match, on purpose: free, instant, predictable, and the
// matched phrase is logged with the score, so the data can be re-scored later
// with something smarter. Explicit labels (/good, /bad, /label) are stronger
// signals and are logged separately.
//
// The next message is often praise plus the next task ("Perfect. Next, fix the
// broken link"), so:
//  - a correction must point back at what was done ("it's broken", "revert
//    that", "you broke"): a bare "broken", "undo" or "wrong" usually describes
//    the next task. Corrections count anywhere in the message.
//  - praise counts only in the first sentence, and not in a question ("that
//    works? no"); "works" and "exactly" only in praising forms ("it works
//    now", "exactly what I wanted"), not "make sure it works on Windows".

export interface ReplySignal {
  score: 1 | -1;
  /** The words that decided it, as the user wrote them. */
  phrase: string;
}

/** Whole words or phrases only: "great" mustn't fire inside "great-grandparent". */
const words = (alternatives: string[], emoji: string[]) =>
  new RegExp(`(?<![\\w-])(?:${alternatives.join("|")})(?![\\w-])${emoji.length ? `|${emoji.join("|")}` : ""}`, "iu");

// Checked first, over the whole message: a correction is often polite ("thanks, but it's still broken").
const NEGATIVE = words(
  [
    "that'?s (?:not|wrong)",
    "not what i",
    "(?:it'?s|that'?s|this is|is|are) (?:wrong|broken)",
    "(?:doesn'?t|does not|didn'?t|did not|isn'?t|is not|still not|not) work(?:ing|s)?",
    "still (?:broken|failing|fails|wrong|not working)",
    "(?:is|are) (?:still )?failing",
    "fails? now",
    "now fails?",
    "you broke",
    "broke (?:it|that|the \\w+)",
    "revert (?:that|it|this|those|the (?:last )?changes?)",
    "undo (?:that|it|this|those|the (?:last )?(?:change|changes|edit|edits)|your (?:change|changes|edit|edits))",
    "why did you",
    "not (?:great|good|right|correct|quite)",
  ],
  ["👎"],
);

const POSITIVE = words(
  [
    "thanks?(?: you)?",
    "thx",
    "ty",
    "perfect",
    "great",
    "awesome",
    "amazing",
    "brilliant",
    "excellent",
    "nice(?: one)?",
    "well done",
    "good job",
    "lgtm",
    "looks good(?: to me)?",
    "^\\s*(?:it|that|this|everything) works(?: now| great| perfectly| fine)?",
    "works (?:now|great|perfectly)",
    "^\\s*exactly",
    "exactly what i (?:wanted|needed|asked for)",
    "love it",
  ],
  ["👍", "🎉", "🙏"],
);

/** The first sentence: where praise for the last turn goes, before the next request. */
const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? "";

/** Whether a message praises or corrects the turn before it, or neither (null). */
export function classifyReply(raw: string): ReplySignal | null {
  const text = raw.replace(/[‘’]/g, "'");
  const negative = NEGATIVE.exec(text);
  if (negative) return { score: -1, phrase: negative[0].trim() };
  const first = firstSentence(text);
  if (first.endsWith("?")) return null; // "that works?" asks, it doesn't praise
  const positive = POSITIVE.exec(first);
  if (positive) return { score: 1, phrase: positive[0].trim() };
  return null;
}
