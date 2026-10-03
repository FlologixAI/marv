import type { Config } from "../config/config.ts";
import { EchoProvider } from "./echo.ts";
import type { Provider } from "./types.ts";

// The one place that maps a config to a concrete Provider.
// Adding a vendor = one new case here; nothing else in the app changes.
export function createProvider(config: Config): Provider {
  switch (config.provider) {
    case "echo":
      return new EchoProvider();
    case "anthropic":
      // Placeholder until milestone 3 adds the real Anthropic adapter.
      return {
        name: config.model,
        async *stream() {
          yield {
            type: "error",
            message: "The Anthropic provider arrives in milestone 3. Use /setup and pick Echo to try the UI for now.",
          };
          yield { type: "done" };
        },
      };
  }
}
