// A side-effect module, imported first by src/sdk.ts. ES imports are hoisted: every module sdk.ts imports runs
// before sdk.ts's own body, and some use Bun at the top level (tools/bash.ts calls Bun.which). A check inside
// sdk.ts would come too late; as the first import, this one runs first. It helps under a runtime that can load
// Marv's TypeScript (Node with a TS loader, say) but has no Bun APIs: a clear message instead of "Bun is not
// defined" from deep inside. Plain Node never gets this far: it fails while linking the modules (a JSON import
// without an import attribute, TypeScript it can't strip), with its own error.
if (typeof Bun === "undefined") throw new Error("@flologixai/marv/sdk runs on Bun (>= 1.3).");
