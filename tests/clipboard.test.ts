import { describe, expect, test } from "bun:test";
import { clipboardCommands, osc52 } from "../src/clipboard.ts";

describe("clipboardCommands", () => {
  test("uses pbcopy on macOS", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy"]]);
  });

  test("prefers wl-copy on Wayland, then the X11 tools", () => {
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" })).toEqual([
      ["wl-copy"],
      ["xclip", "-selection", "clipboard"],
      ["xsel", "--clipboard", "--input"],
    ]);
  });

  test("has nothing to run without a display (e.g. over ssh)", () => {
    expect(clipboardCommands("linux", {})).toEqual([]);
  });
});

test("osc52 base64-encodes the text into the escape sequence", () => {
  expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07");
});
