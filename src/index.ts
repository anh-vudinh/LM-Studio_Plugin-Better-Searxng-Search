import { PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";
import { configSchematics } from "./config";

export async function main(context: PluginContext) {
  // Register configuration schematics
  context.withConfigSchematics(configSchematics);

  // Register the tools provider
  context.withToolsProvider(toolsProvider);

  // Use console.log instead of context.log
  console.log("SearXNG Search Plugin initialized");
}
