// Text written by a model (or read from a file) is shown in the terminal. A
// raw escape sequence in it would be executed by the terminal, not shown: it
// could write the clipboard (OSC 52), retitle the window or redraw the screen.
// Everything that isn't printable is dropped at render time (the model's own
// conversation is untouched), before Ink measures or wraps the text.

// ESC-introduced sequences: CSI (ends at its final byte, or the end of the text so a
// half-streamed one doesn't flicker), strings (OSC/DCS/SOS/PM/APC, until BEL, ST or the
// end), and the short forms (ESC ( B, ESC 7, ESC =, ...); plus the 8-bit CSI \x9b.
// The other 8-bit introducers (\x9d etc.) are deliberately not swallowed with a payload:
// UTF-8 text decoded as Latin-1 ("“" -> "â\x80\x9c") contains them, and eating up to
// a terminator would delete real text. CONTROLS drops the introducer; the rest is visible, harmless text.
const SEQUENCES = /\x1b(?:\[[0-?]*[ -\/]*(?:[@-~]|$)|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[ -\/]*[0-~])|\x9b[0-?]*[ -\/]*[@-~]?/g;
// Any other C0/C1 control, and DEL, except \t and \n (\r would overwrite the line).
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function printable(text: string): string {
  return text.replace(SEQUENCES, "").replace(CONTROLS, "");
}
