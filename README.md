# Schizo Battle

Player cards show LP remaining to the current EUNE Challenger target and estimated consecutive wins at an assumed +30 LP per win. The target comes from Riot's Challenger, Grandmaster, and Master ladders: one LP above the 200th Apex player, with an 800 LP minimum. The same endpoint calculates the Grandmaster target from the 700th Apex player (200 Challenger plus 500 Grandmaster places), with a 400 LP minimum. The LP chart includes dashed live target lines, rank emblems, and subtle tier shading. These are explicitly current cutoffs, not historical cutoff readings. `/api/challenger` caches only the target and timestamp for five minutes. Estimates are hidden if the cutoff is stale or unavailable, or the player has no verified Apex LP reading. Manual Refresh requests fresh rank data, with a 30-second minimum cache between requests.

The `/whos-fault/` page lists shared Solo/Duo losses, newest first, with both champion portraits, each player's K/D/A and KDA ratio, and a short joke verdict beneath each match. Each new match verdict blames Respectful Jew with probability 1/3 and regelepetras2006 with probability 2/3, with player-specific random reasons. Verdicts persist in browser storage across reloads. Any precise timestamp in a joke is generated within the match duration; the page labels these verdicts "Just for fun". Stored teammate matches gain an explicit `teamWon` field through the existing bounded backfill so wins, losses, and remakes are separated correctly.

## Deploy to Netlify

Import `andreilazu/lol_competition`, branch `main`. Leave the base directory blank, use `npm run build:netlify` as the build command, `public` as the publish directory, and `netlify/functions` as the functions directory. These settings are also stored in `netlify.toml`; Node 22 is selected automatically.

Add `RIOT_API_KEY` through Netlify's environment variable settings, available to Functions, before deploying. Never add the key to GitHub or a frontend variable. Netlify Functions run the existing API and Netlify Blobs stores the shared cache, head-to-head results, and LP snapshots across deployments. No separate storage token is needed on Netlify. A public snapshot of the previous host's match results and LP history is included as the initial fallback; new stored entries override it.

Run `npm ci`, `npm test`, `npm run build:netlify`, and `npm run test:netlify` to verify the Netlify build locally. The original `npm run build` still creates the Sites/Cloudflare Worker artifact.

Public EUNE ranked comparison for Respectful Jew #miy23 and regelepetras2006 #smrfm.

Run `npm run dev` for a local preview, `npm test` for checks, and `npm run build` to build the Worker. Local preview has no secret, so it shows the verified public snapshot. Set the RIOT_API_KEY runtime secret through Sites to enable live stats. Never commit the key.

The server resolves Riot IDs through Europe ACCOUNT-V1 and fetches EUNE LEAGUE-V4 Solo/Duo and Flex entries. Successful results are cached in R2 for five minutes. Visitors never supply or receive the key. Shared R2 snapshots record progress when visitors refresh; there is no background collection while the site is closed. The chart retains the most recent 1,000 snapshots and compares cumulative ladder points (Master and above share a baseline). Newer snapshot keys sort first. The initial public snapshot is labeled separately and can be cached at the original source.

Deploy through Sites using .openai/hosting.json, R2 binding BUCKET and the server secret. Riot development keys expire after 24 hours; sustained public service needs an appropriate production key.


## Head-to-head comparison

The shared /api/matchups endpoint searches available ranked MATCH-V5 histories without a calendar-year cutoff. Load older matches starts a continuing paginated scan of both players, with short progress feedback, automatic rate-limit waits, and visible failures. Saved results survive the migration from season-only scans. Older scan cursors use a fixed endTime so new games cannot shift the pagination during a scan. Each request fetches up to one 100-game page per player and checks up to six shared games, within the host's time budget. Missing match details (404) are skipped so one unavailable match cannot block older results. The persistent matchups-all.json cache keeps discoveries across calendar years.

Head-to-head win rates and champion stats count only opposite-team Solo/Duo games and exclude remakes. Teammate games never enter the denominator. Exhausted history means the end of results exposed by Riot, not every game ever played; Riot's match-list and retention limits still apply. Older LP values cannot be reconstructed from match summaries; the LP chart retains verified observations only.

The LP chart uses only verified Riot snapshots, actual timestamps, and either LP change since tracking began or cumulative ladder points. A single snapshot displays an explanation instead of a false progress line. An unchanged history explicitly says LP has not changed. Existing public baseline values remain visible only as a scoreboard fallback.


## Simplified Solo/Duo interface

The public UI shows only Solo/Duo. Head-to-head results remain prominent; match details are collapsed. The chart shows both players' actual LP totals on one shared LP axis against real timestamps, with 24-hour, 7-day, 30-day and all-history filters. No cumulative ladder-point conversions or baseline-change modes are shown. Flex data retained by the existing backend is not exposed in the interface. The existing public URL is preserved.


## Historical LP observations

Verified OP.GG daily tier-graph readings for both accounts were added on 17 November 2026. See historical-lp-provenance.json for source URLs and exact retained readings. These date-only observations are displayed with their calendar date and OP.GG attribution, independently per player; no intraday timestamps or unobserved LP are claimed. Live stats and shared history remain from Riot.

## Champion head-to-head stats

Each player's champion list shows only champion portraits, names, KDA, win rate, and game count from opposing-team Solo/Duo matches. Every champion used in those matches is shown, ordered by game count. Champion filters, sorting controls, detailed match history, CS/XP metrics, and the 24-hour chart filter are omitted to keep the interface concise.

KDA is total kills plus assists divided by total deaths; zero deaths displays Perfect. The backend retains MATCH-V5 summary data and bounded legacy backfill. Champion portraits come from CommunityDragon. An active Riot API key is required for live data.
