// turndown-plugin-gfm ships no types: only what web_fetch uses.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
}
