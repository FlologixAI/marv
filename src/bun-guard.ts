// A side-effect module, imported first by src/sdk.ts. ES imports are hoisted: every module sdk.ts imports runs
// before sdk.ts's own body, and some use Bun at the top level (tools/bash.ts calls Bun.which). A check inside
// sdk.ts would come too late; as the first import, this one runs first and fails with a clear message under Node.
if (typeof Bun === "undefined") throw new Error("marv/sdk runs on Bun (>= 1.3).");
