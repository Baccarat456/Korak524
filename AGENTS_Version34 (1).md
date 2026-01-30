## Roblox Experience Stats scraper — AGENTS

This Actor collects Roblox experience (game) metadata and usage stats. It supports:
- API-first mode (recommended): calls public Roblox endpoints to retrieve structured game/place details.
- CheerioCrawler HTML scraping: fast fallback for static pages.
- PlaywrightCrawler browser rendering: captures dynamic values like current players.

Key output fields:
- experience_id, place_id, name, creator, visits, favorites, playing (current players), maxPlayers, price, genre, url, extracted_at

Do:
- Prefer API mode where possible (faster, more consistent).
- Use Playwright only for JS-heavy pages that embed dynamic counters.
- Respect Roblox Terms of Service, rate limits, and robots.txt. Keep concurrency modest and use proxies for large crawls.
- Store raw API/page JSON in Key-Value store for auditability and incremental diffs.

Don't:
- Do not attempt to access private/account-only data or join private servers.
- Do not scrape or store any user PII.
- Do not hard-code API keys or secrets in code — use environment variables or Apify Secrets.

Next steps you may want:
- Add a CSV input of place/experience IDs (faster than crawling).
- Implement incremental runs: store last-seen metrics in KV and only output changed records.
- Export per-experience time-series CSV (append daily snapshots) for trend analysis.
- Add robust Roblox endpoint selection (universe vs place) and retry/backoff handling when API returns errors.
- Add scraping of additional stats (player retention metrics) if you have access to authorized APIs.

Quick local setup (copy/paste)
1) Create project folder and paste files into corresponding paths.
2) Install dependencies:
   - npm install
3) Run locally:
   - apify run

If you want, I can implement one of the next steps now (pick one):
1) CSV-driven input of place/experience IDs and bulk mode
2) Incremental/diff mode storing last metrics in KV
3) Time-series CSV export (per experience)
4) Convert to Playwright-first with network capture to find dynamic endpoints

Which would you like me to implement next?