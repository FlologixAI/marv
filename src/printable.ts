// Text written by a model (or read from a file) is shown in the terminal. A
// raw escape sequence in it would be executed by the terminal, not shown: it
// could write the clipboard (OSC 52), retitle the window or redraw the screen.
// Everything that isn't printable is dropped at render time (the model's own
// conversation is untouched), before Ink measures or wraps the text.

// ESC-introduced sequences (CSI … final byte, OSC/DCS/SOS/PM/APC … terminator, or to the end of the text),
// and the 8-bit forms of the same (CSI, OSC, DCS, SOS, PM, APC).
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]?|[\x9d\x90\x98\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
// Any other C0/C1 control, and DEL, except \t and \n (\r would overwrite the line).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function printable(text: string): string {
  return text.replace(SEQUENCES, "").replace(CONTROLS, "");
}
