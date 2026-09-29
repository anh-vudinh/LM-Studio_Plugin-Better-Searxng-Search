import type { LMStudioClient } from "@lmstudio/sdk";

/**
 * Ask a local LM Studio model to summarize the final web search results before
 * returning it back to the model.
 */
export async function askModelToSummarizeSearchResults(
    client: LMStudioClient,
    returnPackage: string,
    userInquiry: string,
    characterLimit?: number,
): Promise<string> {
    const model = await client.llm.model();

    const prompt = `
        Multiple webpages have been extracted and provided to you to consolidate, summarize, and transform into a cohesive and digestible narrative. Keep distinct stories and counterarguments separate.

        There is no need to be concise or brief if you are still under the specified character limit.

        At the very beginning of your response, include a [MODEL GENERATED SUMMARY OF WEBPAGES] tag. At the end of your response, include a [SOURCES USED] tag listing all sources that were actually used to create the final summary.

        Although the user's inquiry is not the focal point of the consolidated summary, ensure that the user's inquiry has been satisfied.

        WEBPAGES EXTRACTED: 
        ${returnPackage}

        USER'S INQUIRY: 
        ${userInquiry}

        `.trim();

    const result = await model.respond(prompt, {
        temperature: 0.3,
    });

    const raw = result.content.trim();

    const cleanedText = raw.replace(
        /^[\s\S]*?__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[A-Za-z0-9]+__/,
        ""
    );

    if (cleanedText === "") {
        throw new Error(
            `There was no content to summarize. ` +
            `Model returned: ${raw}`,
        );
    }

    return cleanedText;
}