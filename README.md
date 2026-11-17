# Rift Rivals

Public EUNE ranked comparison for Respectful Jew #miy23 and regelepetras2006 #smrfm.

Run `npm run dev` for a local preview, `npm test` for checks, and `npm run build` to build the Worker. Local preview has no secret, so it shows the verified public snapshot. Set the RIOT_API_KEY runtime secret through Sites to enable live stats. Never commit the key.

The server resolves Riot IDs through Europe ACCOUNT-V1 and fetches EUNE LEAGUE-V4 Solo/Duo and Flex entries. Successful results are cached in R2 for five minutes. Visitors never supply or receive the key. Shared R2 snapshots record progress when visitors refresh; there is no background collection while the site is closed. The chart retains the most recent 1,000 snapshots and compares cumulative ladder points (Master and above share a baseline). Newer snapshot keys sort first. The initial public snapshot is labeled separately and can be cached at the original source.

Deploy through Sites using .openai/hosting.json, R2 binding BUCKET and the server secret. Riot development keys expire after 24 hours; sustained public service needs an appropriate production key.
