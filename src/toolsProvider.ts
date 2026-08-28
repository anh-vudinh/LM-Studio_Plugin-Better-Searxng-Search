import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { configSchematics } from "./config";
import stopwords from "@stdlib/datasets-stopwords-en";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";

/**
 * https://github.com/anh-vudinh
 */
interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  score?: number;
  snippet?: string;
}

interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
}

interface AcceptedSource {
  title: string;
  url: string;
  domain: string;
  engine: string;
  score?: number;
  contentSource: "FETCHED_PAGE";
  content: string;
}

interface RejectedSource {
  title: string;
  url: string;
  reason: string;
}

// Research pipeline settings.
let currentNextPage = 1;  //holding the nextpage number outside of tool if user requests model to continue pulling more results

/**
 * Pause before inspecting a successfully fetched page.
 * This gives transient security/challenge pages a few seconds
 * to render before we decide whether the page is usable.
 * -> Out: void
 */
function sleep(
  ms: number
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sets the character budget allowed based on quantity of sources user requested.
 * - Out: number
 */
function getTotalBudget(
  sourceCount: number, 
  budgetScaler: number
) {
  if (sourceCount === 1) return 2000 * budgetScaler; //2000 per
  if (sourceCount === 2) return 3000 * budgetScaler; //1500 per
  if (sourceCount === 3) return 4000 * budgetScaler; //1333 per
  if (sourceCount === 4) return 4800 * budgetScaler; //1333 per
  if (sourceCount >= 5 && sourceCount <= 7) return 6300 * budgetScaler; //900 per @ 7
  return 8000 * budgetScaler; //800 per @ 10
}

/**
 * Normalize text for challenge detection
 * -> Out: string
 */
function normalizeForDetection(
  text: string
): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect an ACTIVE human-verification page
 * -> Out: string or null
 */
function detectActiveChallenge(
  text: string
): string | null {
  const normalized = normalizeForDetection(text);

  const challengePatterns: Array<[RegExp, string]> = [
    [/verify (?:you're|you are) human/, "active human verification"],
    [/verifying (?:you're|you are) human/, "active human verification"],
    [/please verify (?:you're|you are) human/, "active human verification"],
    [/are you (?:a )?robot/, "active robot verification"],
    [/prove (?:you're|you are) not a robot/, "active robot verification"],
    [/i am not a robot/, "active robot verification"],
    [/i'm not a robot/, "active robot verification"],
    [/checking your browser/, "browser verification"],
    [/checking if you're human/, "human verification"],
    [/checking if you are human/, "human verification"],
    [/please wait while we verify/, "verification process"],
    [/complete (?:the )?(?:captcha|challenge)/, "CAPTCHA/challenge instruction"],
    [/complete the security check/, "security check"],
    [/click to verify/, "verification instruction"],
    [/press and hold to verify/, "press-and-hold verification"],
    [/press and hold to continue/, "press-and-hold verification"],
    [/drag the slider/, "slider verification"],
    [/drag the handle/, "slider verification"],
    [/move the puzzle piece/, "puzzle verification"],
    [/complete the puzzle/, "puzzle verification"],
    [/select all images/, "image verification"],
    [/select all squares/, "image verification"],
    [/select all the (?:images|squares|pictures)/, "image verification"],
    [/which image matches/, "image verification"],
    [/which item matches/, "selection verification"],
    [/which item doesn't belong/, "selection verification"],
  ];

  for (const [pattern, reason] of challengePatterns) {
    if (pattern.test(normalized)) return reason;
  }

  const wordCount = normalized
    .split(/\s+/)
    .filter(Boolean)
    .length;

  const explicitChallengeInstruction =
    /\bverify\s+(?:that\s+)?(?:you(?:'re| are)|yourself)\s+(?:are\s+)?human\b/i.test(normalized) ||
    /\bi\s*(?:am|'m)\s+not\s+a\s+robot\b/i.test(normalized) ||
    /\b(?:select|choose)\s+all\s+(?:the\s+)?(?:images|squares|tiles)\b/i.test(normalized) ||
    /\b(?:move|drag)\s+(?:the\s+)?(?:slider|puzzle\s+piece)\b/i.test(normalized) ||
    /\b(?:press|click)\s+and\s+hold\s+(?:to\s+)?verify\b/i.test(normalized) ||
    /\bcomplete\s+(?:the\s+)?(?:captcha|challenge|verification)\b/i.test(normalized);

  const hasCaptcha = /\b(?:captcha|recaptcha|hcaptcha)\b/i.test(normalized);
  const hasTurnstile = /\bturnstile\b/i.test(normalized);
  const hasChallengeContext = /\b(?:challenge|verification|verify|human|robot)\b/i.test(normalized);

  if (explicitChallengeInstruction) 
    return "active verification challenge detected";
  if (wordCount < 150 && ((hasCaptcha && hasChallengeContext) || (hasTurnstile && hasChallengeContext))) {
    return "active verification challenge detected";
  }

  return null;
}

/**
 * Uses Mozilla readability and other methods to clean up text of website
 * to feed to the model
 * -> Out: string
 */
function extractText(
  html: string, 
  _query = ""
): string {
  try {
    const dom = new JSDOM(html);
    const dirtyMarkup = dom.window.document.documentElement.outerHTML;
    const purify = createDOMPurify(dom.window as unknown as Window & typeof globalThis);
    const cleanHtml = purify.sanitize(dirtyMarkup);

    // Parse the sanitized HTML so we can remove reference
    // sections while the original IDs/classes still exist.
    const cleanedDom = new JSDOM(cleanHtml);

    removeReferenceSectionsFromDocument(cleanedDom.window.document);
    
    // Give the cleaned document to Readability.
    const article = new Readability(cleanedDom.window.document).parse();

    if (!article?.content) return "";

    let text = article.content
      // preserve structure
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(?:p|div|section|article|main|h1|h2|h3|h4|h5|h6|li|tr)>/gi, "\n")
      // remove tags
      .replace(/<[^>]+>/g, " ")
      // decode entities
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // normalize
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim();


    return text;
  } catch {
    return "";
  }
}

/**
 * extractText but bypass need for a query
 * Model finds URL itself and looks it up
 * -> Out: string
 */
function extractTextNoQuery(
  html: string
): string {
  return extractText(html, "");
}

/**
 * Attempts to remove ending citations/references sections like from Wikipedia or books
 * To clean them out before they are counted against the budget
 * -> Out: void
 */
function removeReferenceSectionsFromDocument(
  document: Document
): void {
  /*
   * Normalize attribute/class names so different naming conventions
   * can be matched consistently.
   *
   * Examples:
   *   authorBio       -> author-bio
   *   author_bio      -> author_bio
   *   author-bio      -> author-bio
   *   slice-container-authorBio -> slice-container-author-bio
   */
  const normalizeAttribute = (value: string): string =>
    value
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase();

  const referenceAttributeRe = new RegExp(
    "(?:^|[-_ ])(?:" +
      [
        // References / citations
        "references?",
        "bibliograph(?:y|ies)",
        "reflist",
        "citation(?:s)?",
        "footnotes?",
        "endnotes?",
        "sources?",

        // External links
        "see[-_ ]also",
        "external[-_ ]links?",
        "external[-_ ]resources?",

        // Further reading
        "further[-_ ]reading",
        "additional[-_ ]reading",
        "recommended[-_ ]reading",
        "suggested[-_ ]reading",

        // Additional resources
        "additional[-_ ]resources?",
        "additional[-_ ]information",
        "additional[-_ ]materials?",
        "useful[-_ ]links?",
        "useful[-_ ]resources?",

        // Author / bio
        "author",
        "authors",
        "author[-_ ]?bio",
        "author[-_ ]?biography",
        "writer[-_ ]?bio",
        "writer[-_ ]?biography",
        "contributor[-_ ]?bio",
        "contributor[-_ ]?biography",
        "about[-_ ]the[-_ ]author",

        // Comments
        "comment",
        "comments",
        "discuss",
        "discussion",
        "discussions",
      ].join("|") +
      ")(?:$|[-_ ])",
    "i"
  );

  const referenceHeadingRe = new RegExp(
    [
      // References / citations
      "references?",
      "bibliograph(?:y|ies)",
      "works?\\s+cited",
      "literature\\s+cited",
      "citations?",
      "footnotes?",
      "endnotes?",
      "sources?",

      // Related / external content
      "see\\s+also",
      "external\\s+links?",
      "external\\s+resources?",
      "related\\s+articles?",
      "related\\s+content",
      "related\\s+topics?",
      "related\\s+pages?",
      "related\\s+resources?",

      // Further reading
      "further\\s+reading",
      "additional\\s+reading",
      "recommended\\s+reading",
      "suggested\\s+reading",

      // Additional resources / information
      "additional\\s+resources?",
      "additional\\s+information",
      "additional\\s+materials?",

      // More information / links
      "for\\s+more\\s+information",
      "for\\s+further\\s+information",
      "useful\\s+links?",
      "useful\\s+resources?",

      // Author / bio headings
      "author",
      "authors",
      "about\\s+the\\s+author",
      "about\\s+the\\s+authors",
      "author\\s+bio",
      "author\\s+biography",
      "writer\\s+bio",
      "writer\\s+biography",
      "contributor\\s+bio",
      "contributor\\s+biography",

      // Comments
      "comment",
      "comments",
      "discuss",
      "discussion",
      "discussions",
    ].join("|"),
    "i"
  );

  /*
   * 1. Remove elements whose id/class strongly identifies them
   *    as reference/citation/author containers.
   */
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[id], [class], [aria-labelledby], [aria-label]"
    )
  );

  for (const element of candidates) {
    const id = normalizeAttribute(element.id || "");

    const className =
      typeof element.className === "string"
        ? normalizeAttribute(element.className)
        : "";

    const ariaLabelledBy = normalizeAttribute(
      element.getAttribute("aria-labelledby") || ""
    );

    const ariaLabel = normalizeAttribute(
      element.getAttribute("aria-label") || ""
    );

    if (
      referenceAttributeRe.test(id) ||
      referenceAttributeRe.test(className) ||
      referenceAttributeRe.test(ariaLabelledBy) ||
      referenceAttributeRe.test(ariaLabel)
    ) {
      element.remove();
    }
  }

  /*
   * 2. Remove sections whose heading explicitly identifies
   *    them as references/bibliography/etc.
   */
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6"
    )
  );

  for (const heading of headings) {
    const text = heading.textContent
      ?.replace(/\s+/g, " ")
      .trim();

    if (!text || !referenceHeadingRe.test(text)) {
      continue;
    }

    const level = Number(
      heading.tagName.substring(1)
    );

    let current = heading.nextElementSibling;

    while (current) {
      const next = current.nextElementSibling;

      if (/^H[1-6]$/.test(current.tagName)) {
        const currentLevel = Number(
          current.tagName.substring(1)
        );

        if (currentLevel <= level) {
          break;
        }
      }

      current.remove();
      current = next;
    }

    heading.remove();
  }
}

/**
 * Checks if the candidate is accessible 
 * if they are return their content after good connection
 * -> Out: object
 */
async function checkEligibility(
  result: SearXNGResult,
  timeout: number,
  query: string,
  waitCaptcha: number
): Promise<
  | {
      eligible: true;
      content: string;
    }
  | {
      eligible: false;
      reason: string;
    }
> {
  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    const response = await fetch(result.url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml," +
          "application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      signal: controller.signal,
    });

    if (response.status === 401) {
      return {
        eligible: false,
        reason: "HTTP 401 Unauthorized",
      };
    }

    if (response.status === 403) {
      return {
        eligible: false,
        reason: "HTTP 403 Forbidden — page inaccessible",
      };
    }

    if (response.status === 429) {
      return {
        eligible: false,
        reason: "HTTP 429 Too Many Requests — rate limited",
      };
    }

    if (response.status >= 500) {
      return {
        eligible: false,
        reason: `HTTP ${response.status} ${response.statusText} — server error`,
      };
    }

    if (!response.ok) {
      return {
        eligible: false,
        reason: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    // Give transient challenge pages time before inspecting.
    await sleep(waitCaptcha);

    const html = await response.text();

    const inspectionText = html.substring(0, 100000);

    const challenge = detectActiveChallenge(inspectionText);

    if (challenge) {
      return {
        eligible: false,
        reason: `active verification challenge detected: ${challenge}`,
      };
    }

    const content = extractText(html, query);

    const wordCount = content
      .split(/\s+/)
      .filter(Boolean)
      .length;

    if (wordCount < 150) {
      return {
        eligible: false,
        reason: `insufficient readable page content (${wordCount} words.`,
      };
    }

    return {
      eligible: true,
      content,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        eligible: false,
        reason: `request timed out after ${timeout}ms`,
      };
    }

    return {
      eligible: false,
      reason:
        error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Select the most relevant paragraphs within a length budget.
 * -> Out: string
 */
async function selectRelevantContent(
  content: string,
  query: string,
  maxLength: number,
  fetchFullPage: boolean
): Promise<string> {
  
  // If the content is less than the budget, or user wants the full page fetched no need to filter send it completely through
  if (content.length <= maxLength || fetchFullPage) {
    return content;
  }

  const stopWords = new Set(stopwords());

  // Query is lowercased, punctuations/special characters removed, splits into terms and removes words shorter than 3 characters.
  // Then cleans out common words from the user's query to be able to get more meaningful terms
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .split(/\s+/)
    .filter(
      (term) =>
        term.length >= 3 &&
        !stopWords.has(term)
    );

  const queryPhrase = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (terms.length === 0) {
    return (
      content.substring(0, maxLength).trim() +
      "[...]"
    );
  }

  // Breaks content into paragraphs
  // Cleans out 0-4 word sentences
  const segmenter = new Intl.Segmenter("en", {
    granularity: "sentence",
  });
  
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((text) => {
      const sentences = [...segmenter.segment(text.trim())]
        .map(({ segment }) => segment.trim())
        .filter(Boolean)
        .filter(
          (sentence) =>
            sentence.split(/\s+/).filter(Boolean).length >= 5
        );

      return sentences.join(" ");
    })
    .filter(Boolean);

  // Assign relevancy scores to each paragraph
  const scored = paragraphs.map(
    (paragraph, index) => {
      const lower = paragraph.toLowerCase();

      let score = 0;

      if (
        queryPhrase.length >= 4 &&
        lower.includes(queryPhrase)
      ) {
        score += 5;
      }

      for (const term of terms) {
        const matches = lower.split(term).length - 1;
        score += Math.min(matches, 3);
      }

      return {
        index,
        paragraph,
        score,
      };
    }
  );

  // Remove irrelevant paragraphs and sort by most relevant
  const relevant = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (relevant.length === 0) {
    return (
      content.substring(0, maxLength).trim() +
      "[...]"
    );
  }
  
  // Include the relevant paragraph plus one paragraph of context
  // on either side when space permits
  const selected = new Set<number>();
  let totalLength = 0;

  for (const item of relevant) {
    const start = Math.max(0, item.index - 1);
    const end = Math.min(
      paragraphs.length - 1,
      item.index + 1
    );

    for (let i = start; i <= end; i++) {
      if (selected.has(i)) {
        continue;
      }

      const addition = paragraphs[i] + "\n";

      if (
        totalLength + addition.length > maxLength
      ) {
        continue;
      }

      selected.add(i);
      totalLength += addition.length;
    }

    if (totalLength >= maxLength * 0.95) {
      break;
    }
  }

  // Sort selected paragraph indices by original position
  // so the output reads in document order
  const result = Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => paragraphs[index])
    .join("\n");

  return (
    result.trim() +
    (result.length < content.length
      ? "[...]"
      : "")
  );
}

/**
 * Tries to intelligently filter portions to pull from fetchPageContent requests based on content size to save token size.
 * -> Out: string
 */
async function getSmarterFilter(
  text: string, 
  fetchFullPage: boolean, 
  budgetScaler: number
): Promise<string> {
    const maxLength = 5000 * budgetScaler;

    //If user intentionally turned on Fetch Full Page, send it all back without applying budgets
    if(fetchFullPage) {
      return text;
    }

    //Less than 5000 characters return it all
    if (text.length <= maxLength) {
      return text;
    }

    //More than 5000 but covers less than 40% of the article's length?
    // beginning 25% of ML, end 15% ML. Bumps maxlimit to 13,000
    // middle distributed in three even 20% chunks that expand around the 25%, 50%, and 75% postions
    if (maxLength/text.length <= 0.40) {
      const bonusMaxLength = 13000 * budgetScaler;
      const beginningSize = Math.floor(bonusMaxLength * 0.25);
      const middleSize = Math.floor(bonusMaxLength * 0.20);
      const endingSize = Math.floor(bonusMaxLength * 0.15);
      
      const textLength = text.length;

      // Beginning: starts at 0%.
      const beginningStart = 0;
      const beginningEnd = beginningSize;

      // Middle sections are centered on 25%, 50%, and 75%
      // positions of the original document.
      const firstMidCenter = Math.floor(textLength * 0.25);
      const secondMidCenter = Math.floor(textLength * 0.50);
      const thirdMidCenter = Math.floor(textLength * 0.75);
      const middleHalfSize = Math.floor(middleSize / 2);

      const firstMidStart = firstMidCenter - middleHalfSize;
      const firstMidEnd = firstMidCenter + middleHalfSize;
    
      const secondMidStart = secondMidCenter - middleHalfSize;
      const secondMidEnd = secondMidCenter + middleHalfSize;

      const thirdMidStart = thirdMidCenter - middleHalfSize;
      const thirdMidEnd = thirdMidCenter + middleHalfSize;

      // Ending: ends at 100%.
      const endingStart = textLength - endingSize;
      const endingEnd = textLength;
      
      text =
        // at 0% position expands outwards to beginningSize
        text.slice(beginningStart, beginningEnd) + 
        `[...omitted: ${Math.max(0, firstMidStart - beginningEnd)} characters between sections...]` +
        // expands 10% around the 25% position of the document
        text.slice(firstMidStart, firstMidEnd) +
        `[...omitted: ${Math.max(0, secondMidStart - firstMidEnd)} characters between sections...]` +
        // expands 10% around the 50% position of the document
        text.slice(secondMidStart, secondMidEnd) +
        `[...omitted: ${Math.max(0, thirdMidStart - secondMidEnd)} characters between sections...]` +
        // expands 10% around the 75% position of the document
        text.slice(thirdMidStart, thirdMidEnd) +
        `[...omitted: ${Math.max(0, endingStart - thirdMidEnd)} characters between sections...]` +
        // at 100% position expands backwards to endingSize
        text.slice(endingStart, endingEnd) +
        `[received: ${bonusMaxLength > textLength? textLength : bonusMaxLength} of ${textLength} chars]`;
      return text;
    }

    //More than 5000 but covers more than 40%, but less than 70% of the article's length? return beginning 25% of ML, middle 65% ML, end 10% ML. Bumps maxlimit to 7,000
    if (maxLength/text.length > 0.40 && maxLength/text.length <= 0.70) {
      const bonusMaxLength = 8000 * budgetScaler;
      const beginningSize = Math.floor(bonusMaxLength * 0.25);
      const middleSize = Math.floor(bonusMaxLength * 0.65);
      const endingSize = Math.floor(bonusMaxLength * 0.10);
      
      const textLength = text.length;

      // Beginning: starts at 0%.
      const beginningStart = 0;
      const beginningEnd = beginningSize;

      // Middle: starts at 50%
      const midCenter = Math.floor(textLength * 0.50);
      const middleHalfSize = Math.floor(middleSize / 2);
      const midStart = midCenter - middleHalfSize;
      const midEnd = midCenter + middleHalfSize;

      // Ending: ends at 100%.
      const endingStart = textLength - endingSize;
      const endingEnd = textLength;
      
      text =
        text.slice(beginningStart, beginningEnd) + 
        `[...omitted: ${Math.max(0, midStart - beginningEnd)} chars...]` +
        text.slice(midStart, midEnd) + 
        `[...omitted: ${Math.max(0, endingStart - midEnd)} chars...]` +
        text.slice(endingStart, endingEnd) +
        `[received: ${bonusMaxLength > textLength? textLength : bonusMaxLength} of ${textLength} chars]`;
      return text;
  }

  //More than 5000 but covers more than 60% of the article? return beginning 15% of ML, middle 60% ML, end 15% ML
  if (maxLength/text.length > 0.70) {
    const beginningSize = Math.floor(maxLength * 0.25);
    const middleSize = Math.floor(maxLength * 0.55);
    const endingSize = Math.floor(maxLength * 0.20);
    
    const textLength = text.length;

    // Beginning: starts at 0%.
    const beginningStart = 0;
    const beginningEnd = beginningSize;

    // Middle: starts at 50%
    const midCenter = Math.floor(textLength * 0.50);
    const middleHalfSize = Math.floor(middleSize / 2);
    const midStart = midCenter - middleHalfSize;
    const midEnd = midCenter + middleHalfSize;

    // Ending: ends at 100%.
    const endingStart = textLength - endingSize;
    const endingEnd = textLength;

    text =
      text.slice(beginningStart, beginningEnd) + 
      `[...omitted: ${Math.max(0, midStart - beginningEnd)} chars...]` +
      text.slice(midStart, midEnd) + 
      `[...omitted: ${Math.max(0, endingStart - midEnd)} chars...]` +
      text.slice(endingStart, endingEnd) +
      `[received: ${maxLength > textLength? textLength : maxLength} of ${textLength} chars]`;
    return text;
  }
  return text;
}

/**
 * Grabs the searxng search results page
 * -> Out: SearXNGResults[]
 */
async function fetchSearchPage(
  searchPage: number,
  query: string,
  time_range: string,
  searxngUrl: string,
  checkCandidatesCount: number,
  timeout: number
): Promise<SearXNGResult[]> {
    const searchParams = new URLSearchParams({
      q: query,
      format: "json",
      pageno: String(searchPage),
      safesearch: "0",
    });

    if (time_range) {
      const normalizedTimeRange = time_range.toLowerCase().trim();

      const validRanges = [
        "day",
        "week",
        "month",
        "year",
      ];

      if (validRanges.includes(normalizedTimeRange)) {
        searchParams.append("time_range", normalizedTimeRange);
      }
    }

    const searchUrl = `${searxngUrl}/search?${searchParams.toString()}`;

    console.log(
      `research_web: searching page ${searchPage} for "${query}"`
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout
    );

    let searchResponse: Response;

    try {
      searchResponse = await fetch(searchUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "LM-Studio-Plugin/1.0",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!searchResponse.ok) {
      throw new Error(
        `SearXNG returned ${searchResponse.status}: ` +
        `${searchResponse.statusText}`
      );
    }

    const data = (await searchResponse.json()) as SearXNGResponse;

    if (!data.results || data.results.length === 0) {
      return [];
    }

    const slicePosition = checkCandidatesCount

    return data.results.slice(0, slicePosition);
}

/**
 * Fetch and validate one research candidate.
 * -> Out: object
 */
async function fetchCandidate(
  result: SearXNGResult,
  timeout: number,
  query: string,
  searchCount: number,
  waitCaptcha: number,
  fetchFullPage: boolean,
  budgetScaler: number
): Promise<
  | {
      usable: true;
      title: string;
      url: string;
      domain: string;
      engine: string;
      score?: number;
      content: string;
    }
  | {
      usable: false;
      reason: string;
    }
> {
  let domain: string;

  try {
    domain = new URL(result.url).hostname;
  } catch {
    return {
      usable: false,
      reason: "invalid URL",
    };
  }

  try {
    const eligibility = await checkEligibility(
      result,
      timeout,
      query,
      waitCaptcha,
    );

    if (!eligibility.eligible) {
      return {
        usable: false,
        reason: eligibility.reason,
      };
    }

    let content = eligibility.content;

    const totalBudget = getTotalBudget(searchCount, budgetScaler);

    // Budget returned content.
    const availableLimit = Math.ceil(totalBudget / searchCount);

    content = await selectRelevantContent(
      content,
      query,
      availableLimit,
      fetchFullPage
    );

    return {
      usable: true,
      title: result.title,
      url: result.url,
      domain,
      engine: result.engine,
      score: result.score,
      content,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        usable: false,
        reason: `request timed out after ${timeout}ms`,
      };
    }

    return {
      usable: false,
      reason:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

/**
 * Fetches the snippets of the candidates
 * -> Out: string
 */
async function fetchSnippets(
  candidates: SearXNGResult[]
): Promise<string> {
  const snippetResults = candidates
    .map(
      (candidate, index) =>
          `[${index + 1}] ${candidate.title}\n` +
          `URL: ${candidate.url}\n` +
          `Snippet: ${candidate.content.substring(0, 500)}`
      )
      .join("\n");

  return snippetResults;
}

/**
 * Fetches URL pages user directly requested through their message.
 * -> Out: string
 */
async function fetchPageContent(
  url: string,
  fetchFullPage: boolean,
  budgetScaler: number
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; LM-Studio-Bot/1.0)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }

  const html = await response.text();
  let text = extractTextNoQuery(html);
  const budgetedText = await getSmarterFilter(text, fetchFullPage, budgetScaler);

  return budgetedText;
}

/**
 * Fetches Urls in user message into context
 * -> Out: string
 */
async function handleUserUrlInject(
  urls: string[],
  fetchFullPage: boolean,
  budgetScaler: number
): Promise<string> {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const cleanUrl = url.replace(/^["'](.*)["']$/, '$1');
          const content = await fetchPageContent(cleanUrl, fetchFullPage, budgetScaler);
          return `<UI_Fetch> URL:${url} Content:${content}`;
        } catch (error) {
          return `<UI_Fetch> URL:${url} Error fetching page:${error instanceof Error? error.message : String(error)}`;
        }
      })
    );

    return results.join("\n\n---\n\n");
}

/**
 * Different paths for researching with snippets
 * Research only using snippets
 * -> Out: string
 */
async function handleSnippetsOnly(
  candidates: SearXNGResult[],
  currentSearchPage: number,
  query: string,
  searxngUrl: string,
  checkCandidatesCount: number,
  timeout: number,
  time_range?: string
): Promise<string> {
    candidates = await fetchSearchPage(currentSearchPage, query, time_range ?? "", searxngUrl, checkCandidatesCount, timeout);

    if (candidates.length === 0) {
      return `<SO_Fetch> No search results found for "${query}".`;
    }

    return `<SO_Fetch> Using only Snippets, warn the user in response: ${await fetchSnippets(candidates)}`;
}

/**
 * Different paths for researching with snippets
 * Pulls first search results page, chooses best keyword matching snippet
 * Fetches the best match for model
 * -> Out: string
 */
async function handleSnippetsFirst(
  candidates: SearXNGResult[],
  currentSearchPage: number,
  query: string,
  searxngUrl: string,
  checkCandidatesCount: number,
  timeout: number,
  fetchFullPage: boolean,
  budgetScaler: number,
  time_range?: string
): Promise<string> {
    candidates = await fetchSearchPage(currentSearchPage, query, time_range ?? "", searxngUrl, checkCandidatesCount, timeout);

    if (candidates.length === 0) {
      return `<SF_Fetch> No search results found for "${query}".`;
    }

    // Check if candidate is accessible or blocked by capcha or lacking content
    const accessibleCandidates: {
      candidate: SearXNGResult;
      content: string;
    }[] = [];

    for (const candidate of candidates) {
      const eligibility = await checkEligibility(
        candidate,
        timeout,
        query,
        0 //force no waiting for captcha checking
      );

      if (eligibility.eligible) {
        accessibleCandidates.push({
          candidate,
          content: eligibility.content,
        });
      }
    }

    if (accessibleCandidates.length === 0) {
      return `<SF_Fetch> No accessible search results found for "${query}".`;
    }

    // Rank accessible candidates to find one that best matches query keywords
    // assign a score, then fetch best candidate
    const scoredCandidates = accessibleCandidates.map((item) => {
      const normalize = (text: string): string[] =>
        text
          .toLowerCase()
          .replace(/[’']/g, "")
          .split(/\s+/)
          .map((word) => word.replace(/[^\w]/g, ""))
          .filter(Boolean);

      const titleText = (item.candidate.title ?? "").toLowerCase();
      const snippetText = (item.candidate.snippet ?? "").toLowerCase();
      const urlText = (item.candidate.url ?? "").toLowerCase();

      let hostname = "";

      try {
        hostname = new URL(item.candidate.url).hostname
          .toLowerCase()
          .replace(/^www\./, "");
      } catch {
        // URL was already checked by checkEligibility().
      }

      const titleWords = new Set(normalize(titleText));
      const snippetWords = new Set(normalize(snippetText));
      const urlWords = new Set(normalize(urlText.replace(/[\/\-_.?=&]/g, " ")));

      const queryWords = normalize(query);

      let score = 0;

      // 1. Individual word matches
      for (const word of queryWords) {
        // Title is the strongest signal.
        if (titleWords.has(word)) {
          score += 4;
        }

        // Snippet is useful, but weaker.
        if (snippetWords.has(word)) {
          score += 1;
        }

        // URL path is useful for topical terms.
        if (urlWords.has(word)) {
          score += 2;
        }
      }

      // 2. Consecutive phrase matches
      for (let i = 0; i < queryWords.length - 1; i++) {
        const phrase = `${queryWords[i]} ${queryWords[i + 1]}`;

        if (titleText.includes(phrase)) {
          score += 8;
        }

        if (snippetText.includes(phrase)) {
          score += 3;
        }

        if (urlText.includes(phrase)) {
          score += 4;
        }
      }

      // 3. Exact query phrase
      const normalizedQuery = query
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (normalizedQuery) {
        if (titleText.includes(normalizedQuery)) {
          score += 15;
        }

        if (snippetText.includes(normalizedQuery)) {
          score += 5;
        }
      }


      // 4. Domain/source matching
      // Normalize both so "tom's hardware" becomes "tomshardware".
      const normalizedHostname = hostname
        .replace(/[^a-z0-9]/g, "");

      const normalizedQueryForDomain = query
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const domainTokens = normalizedQueryForDomain.split(" ");

      // Check progressively larger groups of query words against
      // the hostname. This allows "tom's hardware" to match
      // "tomshardware.com" without requiring the entire query to
      // be the domain name.
      for (let start = 0; start < domainTokens.length; start++) {
        for (
          let end = start + 2;
          end <= domainTokens.length;
          end++
        ) {
          const phrase = domainTokens
            .slice(start, end)
            .join("");

          if (phrase.length >= 5 && normalizedHostname.includes(phrase)) {
            const wordCount = end - start;

            // Source/domain match is strong, but not strong enough
            // to override a much better topical match.
            score += 6 * wordCount;
          }
        }
      }

      return {
        candidate: item.candidate,
        content: item.content,
        score,
      };
    });

    scoredCandidates.sort((a, b) => b.score - a.score);

    const bestCandidate = scoredCandidates[0];
    const budgetedText = await getSmarterFilter(bestCandidate.content, fetchFullPage, budgetScaler);

    return `<SF_Fetch> Title:${bestCandidate.candidate.title} URL:${bestCandidate.candidate.url} Content:${budgetedText}`;
}

/**
 * research_web tool
 */
export async function toolsProvider(
  ctl: ToolsProviderController
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const config = ctl.getPluginConfig(configSchematics);
  const searxngUrl = config.get("searxngUrl") as string;
  const defaultSearchCount = config.get("defaultSearchCount") as number;
  const waitCaptcha = config.get("waitCaptchaTimeout") as number;
  const fetchFullPage = config.get("fetchFullPage") as boolean;
  const checkCandidatesCount = config.get("checkCandidatesCount") as number;
  const snippetsModeSelect = config.get("snippetsModeSelect") as string;
  const budgetScaler = config.get("budgetScaler") as number;

  const researchTool = tool({
    name: "research_web",
    description:
      "If user mentions something unfamiliar, it may be beyond your knowledge cutoff;" +
      "use research_web for relevant information before dismissing or correcting their claim."+
      "No extra research_web tool calls until the previous research_web results are evaluated." +
      "If user message includes urls put urls into the 'urls' array." +
      "After two consecutive failures to fetch or no results found, stop and inform user." +
      "It's non-optional, cite sources at the end of your response, formatted as [DOMAIN](URL)." +
      "Distinct stories should remain separated.",
    parameters: {
      query: z
        .string()
        .describe("The topic to research"),
      time_range: z
        .string()
        .optional()
        .describe("Freshness filter: 'day', 'week', 'month', or 'year'"),
      defaultSearchCount: z
        .number()
        .min(1)
        .max(defaultSearchCount)
        .default(1)
        .describe("Quantity of sources user ideally wants"),
      urls: z
        .array(z.string().url())
        .max(4)
        .default([])
        .describe("List of URLs provided by user to fetch"),
    },
    implementation: async (params: {
      query: string;
      time_range?: string;
      defaultSearchCount: number;
      urls?: string[];
    }) => {
      const { query, time_range, defaultSearchCount, urls } = params;
      const page = 1;
      const timeout = 10000;

      try {
        // ----------------------------------------------------------
        // States that persists across search pages
        // ----------------------------------------------------------
        const accepted: AcceptedSource[] = [];
        const rejected: RejectedSource[] = [];
        const acceptedDomains = new Set<string>();
        const sources = defaultSearchCount;

        let currentSearchPage = page;
        let candidates: SearXNGResult[] = [];
        let candidateIndex = 0;
        let totalCandidatesChecked = 0;

        // ----------------------------------------------------------
        // User sent direct URL links in their message
        // Retrieve them as sources for context
        // ----------------------------------------------------------
        if (urls && urls.length > 0){
          return await handleUserUrlInject(
            urls,
            fetchFullPage,
            budgetScaler
          );
        }

        // ----------------------------------------------------------
        // User wants snippets only
        // ----------------------------------------------------------
        if (snippetsModeSelect === "snippets_only"){
          return await handleSnippetsOnly(
            candidates,
            currentSearchPage,
            query,
            searxngUrl,
            checkCandidatesCount,
            timeout,
            time_range
          );
        }

        // ----------------------------------------------------------
        // User wants snippets first
        // ----------------------------------------------------------
        if (snippetsModeSelect === "snippets_first"){
          return await handleSnippetsFirst(
            candidates,
            currentSearchPage,
            query,
            searxngUrl,
            checkCandidatesCount,
            timeout,
            fetchFullPage,
            budgetScaler,
            time_range
          );
        }

        // ----------------------------------------------------------
        // [Start] Normal research_web Route - Get the first page
        // ----------------------------------------------------------
        candidates = await fetchSearchPage(
          currentSearchPage, 
          query, 
          time_range ?? "", 
          searxngUrl, 
          checkCandidatesCount, 
          timeout
        );

        if (candidates.length === 0) {
          return `No search results found for "${query}".`;
        }

        console.log(
          `research_web: received ` +
          `${candidates.length} candidates from page ` +
          `${currentSearchPage}`
        );

        // ----------------------------------------------------------
        // Check candidates sequentially
        //
        // If we exhaust the current page before reaching
        // requested sources, fetch the next page and continue
        // ----------------------------------------------------------
        while (accepted.length < sources) {
          if (candidateIndex >= candidates.length) {
            const nextPage = currentSearchPage + 1;

            console.log(
              `research_web: exhausted page ` +
              `${currentSearchPage} with ` +
              `${accepted.length}/${sources} accepted. ` +
              `Searching page ${nextPage}.`
            );

            const nextCandidates = await fetchSearchPage(nextPage, query, time_range ?? "", searxngUrl, checkCandidatesCount, timeout);

            // No more search results.
            if (nextCandidates.length === 0) {
              console.log(
                `research_web: page ${nextPage} returned no candidates.`
              );
              break;
            }

            currentSearchPage = nextPage;
            candidates = nextCandidates;
            candidateIndex = 0;

            console.log(
              `research_web: received ` +
              `${candidates.length} candidates from page ` +
              `${currentSearchPage}`
            );

            continue;
          }

          // --------------------------------------------------------
          // Process next candidate
          // --------------------------------------------------------
          const candidate = candidates[candidateIndex];
          candidateIndex++;
          totalCandidatesChecked++;

          let domain: string;

          try {
            domain = new URL(candidate.url).hostname.toLowerCase();
          } catch {
            rejected.push({
              title: candidate.title,
              url: candidate.url,
              reason: "invalid URL",
            });
            continue;
          }

          // Keep the source set diverse.
          if (acceptedDomains.has(domain)) {
            rejected.push({
              title: candidate.title,
              url: candidate.url,
              reason: "duplicate domain",
            });
            continue;
          }

          console.log(
            `research_web: CHECKING candidate(${candidateIndex})_p${currentSearchPage}: ` +
            `${candidate.url}`
          );

          const result = await fetchCandidate(
            candidate,
            timeout,
            query,
            defaultSearchCount,
            waitCaptcha,
            fetchFullPage,
            budgetScaler
          );

          if (!result.usable) {
            console.log(
              `research_web: REJECTED candidate(${candidateIndex})_p${currentSearchPage}: ` +
              `${result.reason}`
            );

            rejected.push({
              title: candidate.title,
              url: candidate.url,
              reason: result.reason
            });
            continue;
          }

          // --------------------------------------------------------
          // ACCEPTED SOURCE
          // --------------------------------------------------------

          acceptedDomains.add(domain);

          accepted.push({
            title: result.title,
            url: result.url,
            domain: result.domain,
            engine: result.engine,
            score: result.score,
            contentSource: "FETCHED_PAGE",
            content: result.content
          });

          console.log(
            `research_web: ACCEPTED candidate(${candidateIndex})_p${currentSearchPage}: ` +
            `Accepted Count: ${accepted.length}/${sources}`
          );
        }

        // ----------------------------------------------------------
        // Update the externally tracked page
        // ----------------------------------------------------------

        currentNextPage = currentSearchPage + 1;
        
        // ----------------------------------------------------------
        // Return research package
        // ----------------------------------------------------------

        if (accepted.length === 0) {
          const snippetResults = await fetchSnippets(candidates);

          return (
            `No accessible pages. Search snippets: ${snippetResults}`
          );
        }

        let output = `<NML_FETCH> Query: ${query}`;

        accepted.forEach((source, index) => {
          output +=
            ` SOURCE[${index + 1}] Title:${source.title} URL:${source.url} Content:${source.content}\n`;
        });

        if (accepted.length < sources) {
          output +=
            `Only ${accepted.length} usable sources were found. ` +
            `The next search page is ${currentNextPage}.`;
        }

        return output;

      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return (
            `Research request timed out after ` +
            `${timeout}ms. Check SearXNG at ${searxngUrl}.`
          );
        }

        return (
          `Error researching "${query}": ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  tools.push(researchTool);

  return tools;
}
