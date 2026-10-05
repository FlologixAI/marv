// Implicit feedback: what the user's next message says about the turn before
// it. A plain keyword match, on purpose: free, instant, predictable, and the
// matched phrase is logged with the score, so the data can be re-scored later
// with something smarter. Explicit labels (/good, /bad, /label) are stronger
// signals and are logged separately.

export interface ReplySignal {
  score: 1 | -1;
  /** The words that decided it, as the user wrote them. */
  phrase: string;
}

/** Whole words or phrases only: "great" mustn't fire inside "great-grandparent". */
const words = (alternatives: string[], emoji: string[]) =>
  new RegExp(`(?<![\\w-])(?:${alternatives.join("|")})(?![\\w-])|${emoji.join("|")}`, "iu");

// Checked first: a correction is often polite ("thanks, but it's still broken").
const NEGATIVE = words(
  [
    "that'?s (?:not|wrong)",
    "not what i",
    "wrong",
    "(?:doesn'?t|does not|didn'?t|did not|isn'?t|is not|still not|not) work(?:ing|s)?",
    "still (?:broken|failing|fails|wrong|not working)",
    "broken",
    "you broke",
    "revert(?: that| it)?",
    "undo",
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
    "(?:it |that )?works(?: now)?",
    "exactly",
    "love it",
  ],
  ["👍", "🎉", "🙏"],
);

/** Whether a message praises or corrects the turn before it, or neither (null). */
export function classifyReply(text: string): ReplySignal | null {
  const negative = NEGATIVE.exec(text);
  if (negative) return { score: -1, phrase: negative[0] };
  const positive = POSITIVE.exec(text);
  if (positive) return { score: 1, phrase: positive[0] };
  return null;
}
