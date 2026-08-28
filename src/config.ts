import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "searxngUrl",
    "string",
    {
      displayName: "SearXNG URL",
      subtitle: "Base URL of your local SearXNG instance",
    },
    "http://localhost:8081"
  )
  .field(
    "defaultSearchCount",
    "numeric",
    {
      displayName: "Requested # of Sources",
      subtitle: "Ideal number of sources to return",
      int: true,
      min: 1,
      max: 10,
      slider: {
        min: 1,
        max: 10,
        step: 1,
      },
    },
    3
  )
  .field(
    "checkCandidatesCount",
    "numeric",
    {
      displayName: "Max # Search Results to Check a Page",
      subtitle: "SearXNG returns at most 25 results per page",
      int: true,
      min: 5,
      max: 25,
      slider: {
        min: 5,
        max: 25,
        step: 5,
      },
    },
    25
  )
  .field(
    "budgetScaler",
    "numeric",
    {
      displayName: "Scale Default Budgets by x",
      subtitle: "Decreae or Increase Information Collected. Affects token consumption.",
      min: 0.1,
      max: 2.0,
      slider: {
        min: 0.1,
        max: 2.0,
        step: 0.1,
      },
    },
    1.0
  )
  .field(
    "waitCaptchaTimeout",
    "numeric",
    {
      displayName: "Timeout for Captcha Detection (ms)",
      subtitle:
        "Timeout for SearXNG to detect Captcha and find another source",
      int: true,
      min: 0,
      max: 10000,
      slider: {
        min: 0,
        max: 10000,
        step: 500,
      },
    },
    3000
  )
  .field(
    "snippetsModeSelect",
    "select",
    {
      displayName: "Snippets Mode",
      subtitle:
        "*Recommended* Fallback or First",
        options: [
          { value: "snippets_fallback", displayName: "Fallback (Best)" },
          { value: "snippets_first", displayName: "First Fetch, Return Best Match (Good)" },
          { value: "snippets_only", displayName: "Snippets Only (Worst)" },
        ],
    },
    "snippets_fallback"
  )
  .field(
    "fetchFullPage",
    "boolean",
    {
      displayName: "Fetch Entire Webpages",
      subtitle:
        "*Warning* Enabling this will consume many tokens. This bypasses the budgeting system.",
    },
    false
  )
  .build();