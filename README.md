## Background (8/24/2026)
Got into local AI and found that LM Studio lacked a built in search feature. Found out about Searxng and [rzk's plugin](https://lmstudio.ai/rzk/Searxng-search).
It satiated me for a couple hours then I wanted more from it and for it to do things better. Things like primarily relying on snippets, making too many repeated tool calls, 
over spending tokens for substance lacking snippets, and not enough meaningful control over the search. So I rewrote it.
Nevertheless, thank you rzk for the framework.

## Setup
rzk's original readme is near the bottom of the readme

## LM Studio Plugin Options Descriptions
1) Searxng URL - points to where your Searxng is hosted.
2) Requested # of Sources - controls the ideal amount of sources you wish to retrieve. On occasion a model may choose a lower number, but most often tries to satisfy your request.
3) Max # Search Results to Check a Page - controls how many search results you want to iterate through to meet the amount stated in your "Retrieve up to # of Sources". There are 25 results maximum.
	- if you set this to 10, it will only iterate through 10 of the 25 search results. If your Source request isn't satisfied the model will continue to search on page 2, iterating over the first 10.
4) Scale Default Budgets by - controls the multiplier applied to the budget defaults I set, reference the simple and wide-net budget tables below.
5) Timeout for Captcha Detection - controls how long you wish to wait for Captchas to timeout (auto verify Captchas) before checking if the web page returns any content.
	- I set it to 3000ms = 3seconds. That seemed plenty enough to pass auto verify Captchas for myself. If you set it to 0secs you're saying to the fetcher you don't care to catch any content from auto verify web pages.
	- Just know that if you set it to 10secs, you're accepting you will wait 10 seconds in-between each candidate check. For example, if you do a 10sec timeout + 10 sources requested, 
	- if the first 10 are positive hits with no reasons for rejections, you'll be waiting 100 seconds for those 10 fetches.
6) Snippets only - toggle on if you want to only fetch snippets from the search results. The snippet count returned is affected by the "Max # Search Results to Check a Page".
	- I'll caution you against this, snippet information is just metadata info, I've seen it's contents, it's severely lacking in substance and consumes a bunch of tokens for it.
	- If the model cannot give you a good answer based on that metadata, it will fetch again until it gets enough to answer your question. This is costly. This is one of the key reasons I rewrote rzk's version.
7) Fetch Entire web pages - toggle on to fetch entire web pages without budget constraints. This includes when you ask the model to pull a specific URL,
	- and if you ask a generalized query, it will pull the entire page of each source that it accepts to satisfy your "Requested # of Sources". Mostly the entire web page minus the junk.
	- Where I did try saving you token count though is by still filtering the unnecessary elements like headers, footers and the like, along with sections that are just reference links to other sources.
8) research_web - must remain enabled/checked.

## Things I added
Total rework to logic.
1. Within LM Studio user can: 
	- set number of sources to return
	- set max number of results checked per search page
	- set how long to wait for potential "wait" Captchas to expire
	- toggle to fetch entire web pages, word of warning, this will consume a lot of tokens
	- toggle for snippets (not recommended, but I believe in freedom, it eats up tokens for metadata content of low quality info)
	- scale budgets increase or decrease budgets of my simple and wide-net budget systems

2. You can now paste a URL in the message and the model will go retrieve their content to put into context. Limited to the first 4 URLs per message.

3. Smarter searches and pulls:
	- To save tokens two budgeting system were added which will smartly fetch data.
	- The amount of retrieve sources affects your budget.
	- The size of the whole web page you try to fetch is also affected by budget constraints.
	- If you feel like the data your model received is inadequate because of the budget constraints you can toggle on the, Fetch Entire Webpage, this will be token expensive.
	- The system works like this...
		[start] you send a query
		-> model takes your query and uses Searxng
		-> Searxng returns 25 results (# you set)
		-> now those 25 results will be increment through, rejecting bad candidate web pages that are Captcha protected/lacking substance/inaccessible/incompatible with Mozilla-readability
		-> to find 3 acceptable candidates (# you set)
		-> those 3 candidates will be cleaned (removed tags/reference,citation sections/headers/footers/etc) and a relevancy scorer applied to target relevant and it's neighboring paragraphs based on keywords used in your query
		-> because the tool is doing a multi-search, a SIMPLE budget system will be applied to return X amount of characters per source (refer to table below):
			
			[       Simple Budget Table        ]
			[#_Of_Sources | Total_Characters_Returned]
			[  1   | 2000 ] 2000 per source
			[  2   | 3000 ] 1500 per source
			[  3   | 4000 ] 1333 per source (default)
			[  4   | 5000 ] 1250 per source
			[ 5-7  | 6300 ] 900 per source @ 7
			[ 8-10 | 8000 ] 800 per source @ 10
		
		-> if the user instead provides a URL, for example Wikipedia, or asks the model to fetch a specific Wikipedia topic, it will use a WIDE-NET type of budgeting system for that web page retrieval.
		Because it is a single-search query.
		[end] model puts web pages into context and answer the user's query

	- I had the model perform some tests with the WIDE-NET budgeting on some Wikipedia pages, I had it fetch, in separate chats, the full page(18k tokens) and then fetch with the WIDE-NET(5k tokens).
		I asked it how the data it got back compared to each other, most often it said the WIDE-NET had ~80% of the relevant information it needed for it's response compared to the full page fetch. The info it didn't
		have was just finer details so it couldn't provide in-depth details on those with confidence, but it knew the content was already there based off of enough surrounding context.
					
					[       Wide-Net Budget Table       ]
			[(Char_Budget/Char_Count_Full_Webpage) | Char_Budget ]
						[  <= 40%  | 13000 ] Budget allocation = 25% to beginning, 20% per areas around the 25%, 50%, and 75% marks, 15% to end
						[ 41%-70%  | 8000  ] Budget allocation = 25% to beginning, 65% to middle, 10% to end
						[ 71-100%  | 5000  ] Budget allocation = 25% to beginning, 55% to middle, 20% to end

4. Don't like my default budgets? scale their defaults to how you like between x0.1 to x2.0, default is x1.0. There is a "Fetch Entire Webpage" toggle if you don't want any budgets. Budgeting goal's to save tokens.

5. Added a rough Captcha detection system which will prevent the model from wasting a pull or candidate slot on a Captcha protected site.

6. Added a stack of cleaners that will scrub tags, scripts, reference and citation sections, etc. Basically scrubbed out as many things that would consume token count if it made it back to the model.

7. Fine tuned the tool description so model doesn't misbehave by queuing many searches or have other odd tendencies. rzk's original pulled snippets even if it was going to research, wasting tokens.

8. Set snippets as the fallback if no web pages are accessible. Model will inform you if it's answering based only on snippets. I highly advise against snippets. Low substance, high tokens.
	- Your model may queue up many research_web search queries based on the uncertainties it has, based on just reading snippets and trying to bridge the missing pieces in it's knowledge.

9. Search is no longer limited to just page 1 results. If necessary, due to lack of candidates, it will seek results of the next page. 

10. Fuzzy search, not 100% reliable but "mostly" reliable, because it depends entirely on if the model wishes to do so, but you can ask it "i want you to fetch the Wikipedia american red robin" (not a mistypo, I wanted to see if the model understood)
	- you can also say "fetch me an article from tom's hardware about the rtx 5050's specs"
	- it will first research_web for the first search page, and if it finds the relevant web page similar to your request it will research_web that URL and pull it into context and summarize it.
	- When you ask the model a generalized "fetch me" request, it will call the tool and will give it's response and sources,
	- if you want it to fetch one of the sources it just mentioned, you can ask it a follow up, "can you fetch me the TechTimes article?" and it will go fetch it into context.
	- content fetched into the model is not meant to be pretty/organized, it's for the model. If you're wanting organized text, ask the model to organize it for you or read it in your browser using the source link it provides.

## Bug or feature?
When I have the content run through my budgeting system, I added obvious signs hinting the model that some sections were omitted and how many budgeted characters were pulled into context of the total.
The model might let you know that there is some info missing and offer you the choice to ask it to go and grab the rest.
It can not, and will not be able to get the omitted parts, unless you enable Fetch Entire Webpage.
So if you have Fetch Entire Webpage disabled, do not let it waste it's tokens trying to pull the same page again. Decline it's offer.
I don't want to waste input tokens in the description to add this awareness to the model and potentially inhibiting it from asking follow ups.
You're in the driver seat, you are able to control the toggle.

## Afterwords
If you want to edit my logic or improve it, feel free to do so, but a word of warning from what I can tell every piece and order of function execution matters. Also if you alter or try to compact my tool
description, the tool will cease to function as I intended. Believe me I tried to compact the description as much as possible, and tested it many times if it could be relied on without all those words or lines (striving minimal tokens),
but just messing with their wording would make the tool act up and be unreliable or the model started taking the tool description as suggestions, rather than orders it must follow.

Thanks [rzk](https://lmstudio.ai/rzk/Searxng-search) for your original work.
Below are his original instructions to setting things up for the plugin.

____________________________________________________________________________________________________________________________
____________________________________________________________________________________________________________________________

# Searxng Search Plugin for LM Studio (rzk's original readme)

This plugin enables LM Studio assistants to search the web using a local [Searxng](https://github.com/Searxng/Searxng) instance, providing privacy-focused metasearch capabilities similar to how Vane (Perplexica) utilizes Searxng.

## Prerequisites

1. **Running Searxng Instance**: You must have Searxng installed and running locally (e.g. at `http://localhost:8081` to prevent possible conflicts with other services)
2. **JSON API Enabled**: Ensure your Searxng `settings.yml` includes:
   
   ```yaml
   search:
     formats:
       - html
       - json
   ```

## Installation

1. Download this plugin from LM Studio Hub or install manually
2. Configure the plugin settings in LM Studio:
   - Searxng URL: Your instance URL (default: [http://localhost:8081](http://localhost:8080/)) (if a different port is used, update "config.ts" accordingly. Note that current port setting is "8081" to prevent possible conflicts with other services)
   - Default Results Count: How many results to return per query (1-20)
   - Timeout: Request timeout in milliseconds

## Usage

Once installed, the plugin provides two tools:

- `search_web`: Search the internet using Searxng
- `fetch_page_content`: Retrieve and extract text from specific URLs

The assistant will automatically invoke these tools when web search is needed.



## Project Structure

```
lms-plugin-searxng/
├── manifest.json
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── config.ts
    └── toolsProvider.ts
```

## Troubleshooting

- **"JSON format not enabled"**: Ensure your Searxng settings.yml includes `json` in search formats
- **Connection timeouts**: Verify Searxng is running and accessible at the configured URL
- **No results**: Check that Searxng has search engines enabled in its configuration



## Comparison with Existing Solutions

Unlike the DuckDuckGo plugin which relies on DuckDuckGo's HTML scraping, this Searxng implementation offers:

- Privacy control: Data never leaves your infrastructure (when using local Searxng)
- Customizable sources: Searxng aggregates 70+ search engines configurable by the user
- No rate limits: Local instances aren't subject to external API quotas
- Metadata richness: Access to result scores and source engine attribution

## License

MIT
