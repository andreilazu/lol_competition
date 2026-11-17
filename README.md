# Schizo Battle

Public EUNE ranked comparison for Respectful Jew #miy23 and regelepetras2006 #smrfm.

Run `npm run dev` for a local preview, `npm test` for checks, and `npm run build` to build the Worker. Local preview has no secret, so it shows the verified public snapshot. Set the RIOT_API_KEY runtime secret through Sites to enable live stats. Never commit the key.

The server resolves Riot IDs through Europe ACCOUNT-V1 and fetches EUNE LEAGUE-V4 Solo/Duo and Flex entries. Successful results are cached in R2 for five minutes. Visitors never supply or receive the key. Shared R2 snapshots record progress when visitors refresh; there is no background collection while the site is closed. The chart retains the most recent 1,000 snapshots and compares cumulative ladder points (Master and above share a baseline). Newer snapshot keys sort first. The initial public snapshot is labeled separately and can be cached at the original source.

Deploy through Sites using .openai/hosting.json, R2 binding BUCKET and the server secret. Riot development keys expire after 24 hours; sustained public service needs an appropriate production key.


## Head-to-head comparison

The shared /api/matchups endpoint checks ranked MATCH-V5 histories from 1 January of the current year, starting with 100 ranked matches for each account. Scan older games fetches another page for both players, intersects all discovered IDs, and checks shared matches six at a time. Saved records are deduplicated. Queue-specific head-to-head win rates count only opposite-team games and exclude remakes/early surrenders. Teammate games never enter the denominator. The site displays the sample size and partial-history coverage; reaching the end of available Riot history does not imply every game ever played is available. Retry-After is persisted on throttling.

The LP chart uses only verified Riot snapshots, actual timestamps, and either LP change since tracking began or cumulative ladder points. A single snapshot displays an explanation instead of a false progress line. An unchanged history explicitly says LP has not changed. Existing public baseline values remain visible only as a scoreboard fallback.


## Simplified Solo/Duo interface

The public UI shows only Solo/Duo. Head-to-head results remain prominent; match details are collapsed. The chart shows both players' actual LP totals on one shared LP axis against real timestamps, with 24-hour, 7-day, 30-day and all-history filters. No cumulative ladder-point conversions or baseline-change modes are shown. Flex data retained by the existing backend is not exposed in the interface. The existing public URL is preserved.


## Historical LP observations

Verified OP.GG daily tier-graph readings for both accounts were added on 17 November 2026. See historical-lp-provenance.json for source URLs and exact retained readings. These date-only observations are displayed with their calendar date and OP.GG attribution, independently per player; no intraday timestamps or unobserved LP are claimed. Live stats and shared history remain from Riot.
