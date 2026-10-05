import { describe, expect, test } from "bun:test";
import { classifyReply } from "../src/feedback.ts";

describe("implicit feedback from the user's next message", () => {
  test.each([
    "thanks!",
    "Thank you, that works",
    "perfect",
    "great, now add tests",
    "nice one",
    "lgtm",
    "looks good to me",
    "awesome 🎉",
    "👍",
    "it works now",
    "exactly what I wanted",
  ])("positive: %p", (text) => {
    expect(classifyReply(text)?.score).toBe(1);
  });

  test.each([
    "that's wrong",
    "no, that's not what I asked",
    "it doesn't work",
    "still broken",
    "the tests are still failing",
    "please revert that",
    "undo the last change",
    "why did you delete the file?",
    "not great",
    "👎",
  ])("negative: %p", (text) => {
    expect(classifyReply(text)?.score).toBe(-1);
  });

  test.each(["now add a README", "what does this function do?", "no worries, can you also add tests", "great-grandparent class names"])(
    "no signal: %p",
    (text) => {
      expect(classifyReply(text)).toBeNull();
    },
  );

  test.each([
    ["Perfect. Next, add an undo button", 1],
    ["great, now fix the broken link", 1],
    ["Thanks! Now handle the wrong password case", 1],
    ["nice. can you add a revert endpoint?", 1],
    ["Perfect. But the tests fail now.", -1], // a correction later in the message still counts
    ["it still doesn’t work", -1], // curly apostrophe
    ["this isn’t working", -1],
  ] as [string, 1 | -1][])("praise, then the next task: %p", (text, score) => {
    expect(classifyReply(text)?.score).toBe(score);
  });

  test.each(["fix the broken test", "undo stack implementation please", "explain how the cache works", "make sure it works on windows", "write exactly 3 retries", "that works? no"])(
    "a task or a question is no signal: %p",
    (text) => {
      expect(classifyReply(text)).toBeNull();
    },
  );

  test("a polite correction counts as negative", () => {
    expect(classifyReply("thanks, but it's still broken")).toMatchObject({ score: -1, phrase: "still broken" });
  });

  test("the matched phrase is kept, so the data can be re-scored later", () => {
    expect(classifyReply("Perfect, thanks")).toEqual({ score: 1, phrase: "Perfect" });
  });
});
