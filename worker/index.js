const players=[{name:'Respectful Jew',tag:'miy23',slug:'Respectful%2BJew-miy23'},{name:'regelepetras2006',tag:'smrfm',slug:'regelepetras2006-smrfm'}];
const initial={at:'2026-11-17T13:55:00Z',source:'Public snapshot · League of Graphs',players:[{tier:'GRANDMASTER',rank:'I',lp:1301,wins:397,losses:342},{tier:'GRANDMASTER',rank:'I',lp:1663,wins:285,losses:235}]};
let inFlight, matchupFlight, challengerFlight;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function riot(url,key){const r=await fetch(url,{headers:{'X-Riot-Token':key},signal:AbortSignal.timeout(15000)});if(!r.ok){const e=new Error(({401:'Riot rejected this API key.',403:'The server’s Riot API key is invalid or expired. The site owner needs to replace it.',404:'Account or ranked data not found on EUNE.',429:'Riot rate limit reached. Please wait and retry.'})[r.status]||'Riot is temporarily unavailable. Please retry.');e.riotStatus=r.status;e.status=r.status===429?429:502;e.retryAfter=Math.max(5,Number(r.headers.get('Retry-After'))||120);throw e;}return r.json();}
// Riot encrypts player IDs per API key, so cached IDs are only valid for the key that fetched them.
// A short hash of the key (never the key) records which key that was; a rotated key refetches them.
async function keyTag(key){const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));return [...new Uint8Array(h).slice(0,6)].map(b=>b.toString(16).padStart(2,'0')).join('');}
async function accounts(env,key,force=false){
 const tag=await keyTag(key),old=await env.BUCKET?.get('accounts.json');
 if(old&&!force){const mark=await env.BUCKET.get('accounts-key.json'),saved=mark?(await mark.json()).tag:null;
  // Caches from before this check adopt the current key; a mismatch inside a match triggers a refetch anyway.
  if(!saved)await env.BUCKET.put('accounts-key.json',JSON.stringify({tag}));
  if(!saved||saved===tag)return old.json();}
 const ids=await Promise.all(players.map(p=>riot('https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/'+encodeURIComponent(p.name)+'/'+p.tag,key)));
 await env.BUCKET?.put('accounts.json',JSON.stringify(ids));await env.BUCKET?.put('accounts-key.json',JSON.stringify({tag}));return ids;
}
async function challenger(request,env){
 if(request.method!=='GET')return json({error:'Use GET.'},405);
 const cached=await env?.BUCKET?.get('challenger-cutoff.json');const saved=cached?await cached.json():null;
 if(saved&&Number.isFinite(saved.grandmasterTargetLp)&&Date.now()-Date.parse(saved.at)<300000)return json(saved);
 if(challengerFlight)return (await challengerFlight).clone();
 challengerFlight=(async()=>{try{
  if(!env?.RIOT_API_KEY)throw Error('Challenger cutoff unavailable.');
  const leagues=await Promise.all(['challenger','grandmaster','master'].map(tier=>riot('https://eun1.api.riotgames.com/lol/league/v4/'+tier+'leagues/by-queue/RANKED_SOLO_5x5',env.RIOT_API_KEY)));
  if(leagues.some(league=>!Array.isArray(league.entries)))throw Error('Invalid ladder response.');
  const entries=leagues.flatMap(league=>league.entries);
  if(entries.some(e=>!Number.isFinite(e.leaguePoints)||e.leaguePoints<0))throw Error('Invalid ladder LP.');
  // EUNE has 200 Solo/Duo Challenger places; include all Apex tiers for the next refresh.
  const points=entries.map(e=>e.leaguePoints).sort((a,b)=>b-a);
  // Keep the current top 50 so news can spot ladder stars in past lobbies.
  const top=leagues.flatMap((league,t)=>league.entries.map(e=>({puuid:e.puuid,lp:e.leaguePoints,tier:['CHALLENGER','GRANDMASTER','MASTER'][t]}))).filter(e=>e.puuid).sort((a,b)=>b.lp-a.lp).slice(0,50);
  if(top.length)await env?.BUCKET?.put('apex-top.json',JSON.stringify({at:new Date().toISOString(),top}));
  const result={at:new Date().toISOString(),targetLp:Math.max(800,points.length>=200?points[199]+1:800),grandmasterTargetLp:Math.max(400,points.length>=700?points[699]+1:400),source:'Riot API'};
  await env?.BUCKET?.put('challenger-cutoff.json',JSON.stringify(result));return json(result);
 }catch(e){return saved?json({...saved,stale:true}):json({error:'Challenger cutoff unavailable.'},503);}finally{challengerFlight=null;}})();
 return (await challengerFlight).clone();
}
function publicMatchups(s){return {checkedAt:s.checkedAt,counts:s.ids.map(a=>a.length),exhausted:s.exhausted,pending:s.pending.length,records:s.records.map(({lobby,...r})=>r),season:s.season,historyScope:s.historyScope||'season',verificationVersion:s.verificationVersion||0,accountsCheckedAt:s.accountsCheckedAt||null,unavailable:s.unavailable?.length||0,rateLimited:Boolean(s.rateLimited),error:s.error||null,retryAt:s.retryAt||null};}
async function matchups(request,env){
 const deadline=env.MATCHUP_BUDGET_MS?Date.now()+env.MATCHUP_BUDGET_MS:Infinity;
 if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed'},405);
 if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==new URL(request.url).origin)return json({error:'Origin rejected.'},403);
 if(matchupFlight)return (await matchupFlight).clone();
 matchupFlight=(async()=>{let state;try{
  if(!env.BUCKET)return json({error:'Shared storage is unavailable.'},503);
  const season=new Date().getUTCFullYear();const stored=await env.BUCKET.get('matchups-all.json')||await env.BUCKET.get('matchups-'+season+'.json');state=stored?await stored.json():{season,ids:[[],[]],offset:[0,0],exhausted:[false,false],processed:[],pending:[],records:[],checkedAt:null};
  if(state.historyScope!=='available'){
   state.historyScope='available';state.offset=[0,0];state.exhausted=[false,false];state.scanEndTime=Math.floor(Date.now()/1000);state.checkedAt=null;
  }
  if(request.method==='GET')return json(publicMatchups(state));
  // Backfill stored match summaries in bounded batches without losing results.
  state.pending=[...new Set([...state.pending,...state.records.filter(r=>(['opponents','teammates'].includes(r.kind)&&r.statsVersion!==RECORD_VERSION&&!r.detailsUnavailable)||(r.kind==='teammates'&&typeof r.teamWon!=='boolean')).map(r=>r.id)])];
  if(state.retryAt&&Date.now()<Date.parse(state.retryAt))return json(publicMatchups(state));
  if(!env.RIOT_API_KEY)return json({error:'The server needs a Riot API key.'},503);
  const params=new URL(request.url).searchParams;
  const verify=params.get('refresh')==='1'||state.verificationVersion!==1;
  const key=env.RIOT_API_KEY;let aa=await accounts(env,key,verify),fresh=verify;const older=params.get('older')==='1';
  const refreshIds=async()=>{aa=await accounts(env,key,true);fresh=true;state.accountsCheckedAt=new Date().toISOString();};
  if(verify){
   state.ids=[[],[]];state.offset=[0,0];state.exhausted=[false,false];state.processed=[];
   state.pending=state.records.map(r=>r.id);state.checkedAt=null;state.scanEndTime=Math.floor(Date.now()/1000);
   state.verificationVersion=1;state.accountsCheckedAt=new Date().toISOString();
  }
  if((verify||!state.pending.length)&&(older||!state.checkedAt||Date.now()-Date.parse(state.checkedAt)>300000)){
   for(let i=0;i<2;i++){
    if(older&&state.exhausted[i])continue;
    const start=older?state.offset[i]:0;
    const idsUrl=()=>'https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/'+encodeURIComponent(aa[i].puuid)+'/ids?type=ranked'+(older?'&endTime='+state.scanEndTime:'')+'&start='+start+'&count=100';
    // Riot answers 400 when a player ID was encrypted for a different key.
    let ids;try{ids=await riot(idsUrl(),key);}catch(e){if(e.riotStatus!==400||fresh)throw e;await refreshIds();ids=await riot(idsUrl(),key);}
    state.ids[i]=[...new Set([...state.ids[i],...ids])];if(older)state.offset[i]=start+ids.length;if(older||!state.checkedAt)state.exhausted[i]=ids.length<100;
    // Save each cursor so a rate limit on the other account cannot discard progress.
    await env.BUCKET.put('matchups-all.json',JSON.stringify(state));
   }
   const other=new Set(state.ids[1]),done=new Set(state.processed);state.pending=[...new Set([...state.pending,...state.ids[0].filter(id=>other.has(id)&&!done.has(id))])];state.checkedAt=new Date().toISOString();
  }
  // Recompute even after a partial page scan was interrupted by rate limiting.
  const other=new Set(state.ids[1]),done=new Set(state.processed);state.pending=[...new Set([...state.pending,...state.ids[0].filter(id=>other.has(id)&&!done.has(id))])];
  state.error=null;state.retryAt=null;state.rateLimited=false;
  for(let n=0;n<6&&state.pending.length&&Date.now()<deadline;n++){
   const id=state.pending[0];let match;
   try{match=await riot('https://europe.api.riotgames.com/lol/match/v5/matches/'+encodeURIComponent(id),key);}catch(e){
    if(e.riotStatus!==404)throw e;
    state.unavailable=[...new Set([...(state.unavailable||[]),id])];if(!state.processed.includes(id))state.processed.push(id);state.pending.shift();continue;
   }
   const info=match.info;
   let pp=aa.map(a=>info.participants.find(p=>p.puuid===a.puuid));
   // Neither player found means the cached IDs are stale, not that the game is wrong.
   if(!pp.some(Boolean)&&!fresh){await refreshIds();pp=aa.map(a=>info.participants.find(p=>p.puuid===a.puuid));}
   if(pp.every(Boolean)&&[420,440].includes(info.queueId)){
    const duration=info.gameEndTimestamp?Math.round((info.gameEndTimestamp-info.gameStartTimestamp)/1000):info.gameDuration;
    const remake=duration<300||pp.some(p=>p.gameEndedInEarlySurrender);
    const kind=remake?'remake':pp[0].teamId===pp[1].teamId?'teammates':'opponents';
    const number=v=>Number.isFinite(v)&&v>=0?v:null;
    const record={id,queue:info.queueId===420?'solo':'flex',at:new Date(info.gameStartTimestamp).toISOString(),duration,kind,teamWon:kind==='teammates'?Boolean(pp[0].win):null,winner:pp[0].win===pp[1].win?null:pp[0].win?0:1,champions:pp.map(p=>p.championName),kda:pp.map(p=>[p.kills,p.deaths,p.assists].join('/')),statsVersion:RECORD_VERSION,surrender:Boolean(pp[0].gameEndedInSurrender),verifiedAt:new Date().toISOString(),gameVersion:info.gameVersion||null,stats:pp.map(p=>({championId:number(p.championId),kills:number(p.kills),deaths:number(p.deaths),assists:number(p.assists),cs:number(p.totalMinionsKilled)!==null&&number(p.neutralMinionsKilled)!==null?p.totalMinionsKilled+p.neutralMinionsKilled:null,xp:number(p.champExperience),spree:number(p.largestKillingSpree),multi:number(p.largestMultiKill),quadra:number(p.quadraKills),penta:number(p.pentaKills),soloKills:number(p.challenges?.soloKills),vision:number(p.visionScore),position:p.teamPosition||null})),lobby:info.participants.filter(p=>!pp.includes(p)).map(p=>({puuid:p.puuid,name:p.riotIdGameName?p.riotIdGameName+'#'+p.riotIdTagline:null,champion:p.championName||null,championId:number(p.championId),with:pp.map(t=>t.teamId===p.teamId),win:Boolean(p.win)}))};
    const existing=state.records.findIndex(r=>r.id===id);if(existing<0)state.records.push(record);else state.records[existing]=record;
   }else if(!pp.some(Boolean)){const kept=state.records.find(r=>r.id===id);if(kept)kept.detailsUnavailable=true;}
   // Only one player in the game: a genuinely wrong record, safe to drop.
   else{state.records=state.records.filter(r=>r.id!==id);}
   if(!state.processed.includes(id))state.processed.push(id);state.pending.shift();
  }
  await env.BUCKET.put('matchups-all.json',JSON.stringify(state));return json(publicMatchups(state));
 }catch(e){if(state){state.error=e.message;state.rateLimited=e.status===429;state.retryAt=new Date(Date.now()+(e.status===429?e.retryAfter:30)*1000).toISOString();await env.BUCKET.put('matchups-all.json',JSON.stringify(state));return json(publicMatchups(state));}return json({error:e.message},e.status||502);}finally{matchupFlight=null;}})();return (await matchupFlight).clone();
}
// Live games: Spectator-V5 for both players, cached briefly so many viewers share one Riot lookup.
let liveFlight;
const LIVE_TTL=20000;
function rankOf(entries){const e=entries.find(e=>e.queueType==='RANKED_SOLO_5x5');return e?{tier:e.tier,rank:e.rank,lp:e.leaguePoints,wins:e.wins,losses:e.losses}:{tier:'UNRANKED'};}
async function participantRanks(participants,key){
 // null marks a failed lookup so the next refresh retries it; UNRANKED is a real answer.
 return Promise.all(participants.map(async p=>{if(!p.puuid||p.bot)return {tier:'UNRANKED'};try{return rankOf(await riot('https://eun1.api.riotgames.com/lol/league/v4/entries/by-puuid/'+encodeURIComponent(p.puuid),key));}catch{return null;}}));
}
function liveGame(raw,tracked,aa,ranks){
 return {gameId:raw.gameId,queueId:raw.gameQueueConfigId??null,gameMode:raw.gameMode||null,mapId:raw.mapId??null,
  startedAt:raw.gameStartTime>0?new Date(raw.gameStartTime).toISOString():null,gameLength:Number(raw.gameLength)||0,tracked,
  participants:(raw.participants||[]).map((p,i)=>{const t=aa.findIndex(a=>a.puuid===p.puuid);return {teamId:p.teamId,championId:p.championId,riotId:p.riotId||null,bot:Boolean(p.bot),spells:[p.spell1Id,p.spell2Id],tracked:t<0?null:t,rank:ranks[i]||null};}),
  bans:(raw.bannedChampions||[]).filter(b=>b.championId>0).map(b=>({championId:b.championId,teamId:b.teamId}))};
}
const publicLive=s=>({at:s.at,games:s.games,stale:Boolean(s.stale),error:s.error||null});
async function live(request,env){
 if(request.method!=='GET')return json({error:'Use GET.'},405);
 const cached=await env?.BUCKET?.get('live.json');const saved=cached?await cached.json():null;
 if(saved&&Date.now()-Date.parse(saved.at)<LIVE_TTL)return json(publicLive(saved));
 if(liveFlight)return (await liveFlight).clone();
 liveFlight=(async()=>{try{
  const key=env?.RIOT_API_KEY;if(!key){const e=Error('The server needs a Riot API key.');e.status=503;throw e;}
  const aa=await accounts(env,key);
  const found=await Promise.all(aa.map(async a=>{try{return await riot('https://eun1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/'+encodeURIComponent(a.puuid),key);}catch(e){if(e.riotStatus===404)return null;throw e;}}));
  // Group by game id: a duo in the same game becomes one entry with both players tracked.
  const groups=[];found.forEach((g,i)=>{if(!g)return;const same=groups.find(x=>x.raw.gameId===g.gameId);if(same)same.tracked.push(i);else groups.push({raw:g,tracked:[i]});});
  const ranks={};
  for(const g of groups){const old=saved?.ranks?.[g.raw.gameId];ranks[g.raw.gameId]=old&&!old.includes(null)?old:await participantRanks(g.raw.participants||[],key);}
  const result={at:new Date().toISOString(),games:groups.map(g=>liveGame(g.raw,g.tracked,aa,ranks[g.raw.gameId])),ranks};
  await env?.BUCKET?.put('live.json',JSON.stringify(result));return json(publicLive(result));
 }catch(e){return saved?json({...publicLive(saved),stale:true,error:e.message}):json({error:e.message},e.status||502);}finally{liveFlight=null;}})();
 return (await liveFlight).clone();
}
// ---------- News: stories written automatically from the games both players share ----------
// Records at this version carry highlight stats and the other eight players, which the news engine reads.
const RECORD_VERSION=2;
// A game becomes an article only when its best angle scores at least this; everything else stays a plain result.
const NEWS_THRESHOLD=55;
const NUMBER_WORDS=['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
const numberWord=n=>NUMBER_WORDS[n]||String(n);
const ordinal=n=>{const s=['th','st','nd','rd'],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);};
const kdaText=s=>s.kills+'/'+s.deaths+'/'+s.assists;
const kdaRatio=s=>(s.kills+s.assists)/Math.max(1,s.deaths);
const fillText=(t,v)=>t.replace(/\{(\w+)\}/g,(_,k)=>v[k]??'').replace(/\ba (?=(?:8\d*|11|18)\b)/g,'an ');
const textSeed=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
const won=r=>r[0]+r[1];
// Match-V5 uses internal champion names; headlines use the names players know.
const CHAMPION_NAMES={MonkeyKing:'Wukong',DrMundo:'Dr. Mundo',KogMaw:"Kog'Maw",Khazix:"Kha'Zix",Chogath:"Cho'Gath",Velkoz:"Vel'Koz",KSante:"K'Sante",Belveth:"Bel'Veth",Kaisa:"Kai'Sa",RekSai:"Rek'Sai",Nunu:'Nunu & Willump',Renata:'Renata Glasc',FiddleSticks:'Fiddlesticks',JarvanIV:'Jarvan IV',Leblanc:'LeBlanc'};
const championName=n=>n?CHAMPION_NAMES[n]||n.replace(/([a-z])([A-Z])/g,'$1 $2'):'Unknown';
const STORIES={
 first:{h:['It begins: {W} wins the first ever meeting','First blood in the rivalry goes to {W}'],lede:["The first recorded Solo/Duo clash between the two went to {W}: {WC} finished {WK} against {L}'s {LC} ({LK})."],fact:'First recorded meeting between the two.'},
 snap:{h:["{W} ends {L}'s {nw}-game reign",'Streak over: {W} finally gets one back on {L}',"{L}'s {n}-game run comes crashing down"],lede:['{L} had won the last {n} meetings in a row. {W} put a stop to it on {WC}, finishing {WK}.'],fact:"Snapped {L}'s {n}-game winning run."},
 streak:{h:['{W} makes it {nw} in a row over {L}','{n} straight: {W} owns this rivalry right now','Still no answer for {L} as {W} wins again'],lede:["That is {n} consecutive head-to-head wins for {W}. This time {WC} ({WK}) beat {L}'s {LC} ({LK})."],fact:'{W} has now won {n} meetings in a row.'},
 lead:{h:['{W} takes the all-time lead over {L}','New leader: {W} goes {a}–{b} up'],lede:["{W}'s {WC} ({WK}) beat {L}'s {LC}, and {W} now leads the all-time head-to-head {a}–{b}."],fact:'{W} now leads the series {a}–{b}.'},
 level:{h:['All square: {W} levels the series at {a}–{a}','{W} pulls level with {L}'],lede:["{W}'s {WC} ({WK}) beat {L}'s {LC} to tie the all-time head-to-head at {a}–{a}."],fact:'The series is level at {a}–{a}.'},
 milestone:{h:['Meeting #{n} goes to {W}','{n} meetings in, {W} strikes again'],lede:["{W} and {L} have now faced each other {n} times. After {W}'s {WC} ({WK}) took this one, the series stands at {S}."],fact:'Meeting number {n}.'},
 pair:{h:['{WC} vs {LC}, round {n}: {W} takes it','The {WC}–{LC} matchup strikes again'],lede:["This was the {nth} time {W}'s {WC} met {L}'s {LC}. {W} is now {pa}–{pb} in this exact matchup."],fact:'{WC} vs {LC} for the {nth} time ({W} {pa}–{pb}).'},
 penta:{h:['PENTAKILL: {P} wipes the lobby on {C}','{P} finds a pentakill on {C}'],lede:['{P} went {PK} on {C}, with a pentakill along the way{res}.'],fact:'{P} scored a pentakill on {C}.'},
 quadra:{h:["Quadra kill: {P}'s {C} nearly clears the lobby",'{P} goes four-for-four on {C}'],lede:['{P} found a quadra kill on {C} and finished {PK}{res}.'],fact:'{P} scored a quadra kill on {C}.'},
 rampage:{h:["{P}'s {C} goes on a {spree}-kill rampage",'Unkillable: {P} strings together {spree} kills on {C}'],lede:['{P} racked up {spree} kills without dying on {C}, finishing {PK}{res}.'],fact:'{P} went on a {spree}-kill spree.'},
 killfest:{h:['{K} kills for {P} on {C}','{P} turns the game into a highlight reel on {C}'],lede:['{P} finished {PK} on {C}{res}.'],fact:'{P} went {PK} on {C}.'},
 nightmare:{h:['{P} has a night to forget on {C}: {PK}',"{D} deaths: {P}'s {C} gets punished",'Rough one for {P}: {C} goes {PK}'],lede:['{P} died {D} times on {C} and finished {PK}{res}.'],fact:'{P} went {PK} on {C}.'},
 kdalie:{h:["{L}'s {LK} {LC} wasn't enough",'Great KDA, wrong result: {L} goes {LK} and loses anyway',"{W} wins despite {L}'s {LK} scoreline"],lede:["{L} finished {LK} on {LC}, the better scoreline, but {W}'s {WC} ({WK}) was on the winning side."],fact:'{L} went {LK} and still lost.'},
 nokills:{h:['Zero kills, {A} assists: {W} wins without touching the scoreboard','{W} goes {WK} and still beats {L}'],lede:["{W} didn't get a single kill on {WC} and didn't need one: {A} assists and a win over {L}'s {LC} ({LK})."],fact:'{W} won with zero kills ({WK}).'},
 ff:{h:["Over in {m} minutes: {L}'s team calls it",'{m}-minute surrender as {W} rolls {L}'],lede:["{L}'s team surrendered after just {m} minutes. {W} finished {WK} on {WC}."],fact:'Ended in a {m}-minute surrender.'},
 marathon:{h:["{m}-minute war ends in {W}'s favour",'Marathon: {W} outlasts {L} after {m} minutes'],lede:["{W} and {L} went the full {m} minutes before {W}'s {WC} ({WK}) closed it out."],fact:'Lasted {m} minutes.'},
 gap:{h:['{days} days later, the rivalry is back and {W} wins it','The rivalry returns after {days} days'],lede:["It had been {days} days since their last head-to-head. {W} won the return on {WC} ({WK}) against {L}'s {LC}."],fact:'First meeting in {days} days.'},
 sameday:{h:['The {nth} meeting of the day goes to {W}',"Can't stop queueing into each other: game {dn} of the day goes to {W}"],lede:["{W} and {L} met for the {nth} time that day. {W}'s {WC} ({WK}) took this one."],fact:'{nth} meeting of the day.'},
 revenge:{h:['Instant revenge: {W} hits straight back','{W} gets revenge on {L} within hours'],lede:['Fresh off a loss to {L}, {W} won the rematch on {WC} ({WK}).'],fact:'Revenge for the previous meeting.'},
 starwin:{h:['{W} beats {L} with EUNE #{pos} {name} on the team',"EUNE #{pos} {name} joins {W}'s side in the win"],lede:["{name}, currently #{pos} on the EUNE ladder ({lp} LP), played on {W}'s team. {W}'s {WC} ({WK}) beat {L}'s {LC}."],fact:"EUNE #{pos} {name} was on {W}'s team."},
 starloss:{h:['Not even EUNE #{pos} {name} could save {L}','{W} beats {L} and EUNE #{pos} {name} with them'],lede:["{name}, currently #{pos} on the EUNE ladder ({lp} LP), was on {L}'s team. {W} won anyway with {WC} ({WK})."],fact:"EUNE #{pos} {name} was on {L}'s losing team."},
 duowin:{h:['{A} and {B} are on a {n}-game duo win streak','{NW} straight duo wins for {A} and {B}'],lede:['The latest: {AC} ({AK}) and {BC} ({BK}) won in {m} minutes. That makes {n} duo wins in a row.'],fact:'{n}-game duo win streak.'},
 duoloss:{h:['Duo in crisis: {nw} straight losses together','{A} and {B} have now lost {n} duo games in a row'],lede:["The latest: {AC} ({AK}) and {BC} ({BK}) went down in {m} minutes. Who's fault? The verdicts are in."],fact:'{n} duo losses in a row.'},
 duosnap:{h:['{A} and {B} finally win together again','Losing streak over: the duo snaps a {n}-game skid'],lede:['After {n} straight losses as a duo, {AC} ({AK}) and {BC} ({BK}) got the win.'],fact:'Ended a {n}-game duo losing streak.'},
 duostarwin:{h:['{A} and {B} win with EUNE #{pos} {name} on the team'],lede:['{name}, currently #{pos} on the EUNE ladder ({lp} LP), joined the duo and they won: {AC} ({AK}) and {BC} ({BK}).'],fact:'EUNE #{pos} {name} was on their team.'},
 duostarloss:{h:["Even EUNE #{pos} {name} couldn't save the duo"],lede:['{name}, currently #{pos} on the EUNE ladder ({lp} LP), was on their team, but {AC} ({AK}) and {BC} ({BK}) still lost.'],fact:'Lost with EUNE #{pos} {name} on the team.'},
 duostarbeat:{h:['{A} and {B} take down EUNE #{pos} {name}'],lede:['{name}, currently #{pos} on the EUNE ladder ({lp} LP), was on the other side. {AC} ({AK}) and {BC} ({BK}) won anyway.'],fact:'Beat a team with EUNE #{pos} {name} on it.'},
 duostarlost:{h:['EUNE #{pos} {name} beats the duo'],lede:["{name}, currently #{pos} on the EUNE ladder ({lp} LP), was on the enemy team. {AC} ({AK}) and {BC} ({BK}) couldn't stop it."],fact:'Lost to a team with EUNE #{pos} {name} on it.'},
 facecurse:{h:['Whoever gets {name} loses','The {name} curse strikes again'],lede:['{name} has turned up in {seen} of the games the two shared. In their head-to-heads, the side with {name} on it is {sw}–{sl}.']},
 facecharm:{h:['Whoever gets {name} wins','{name}: the head-to-head kingmaker'],lede:['{name} has turned up in {seen} of the games the two shared. In their head-to-heads, the side with {name} on it is {sw}–{sl}.']},
 faceallyloss:{h:['The {name} curse: {X} is 0–{g} with them on the team'],lede:['{name} has turned up in {seen} of the games the two shared. With {name} on the team, {X} is 0–{g}.']},
 faceallywin:{h:['Lucky charm: {X} is {g}–0 with {name} on the team'],lede:['{name} has turned up in {seen} of the games the two shared. With {name} on the team, {X} is {g}–0.']},
 facenemesis:{h:["{name} has {X}'s number: {g}–0"],lede:['{name} has turned up in {seen} of the games the two shared. Facing {name}, {X} is 0–{g}.']},
 facevictim:{h:['{X} is {g}–0 against {name}'],lede:['{name} has turned up in {seen} of the games the two shared. Facing {name}, {X} is {g}–0.']},
 face:{h:['Familiar face: {name} keeps showing up','{name}, again: {nth} shared game'],lede:['{name} has now turned up in {seen} of the games the two shared.']}
};
// Streaks only make headlines at milestone lengths; in between they stay a supporting fact.
const streakScore=(n,first,step,base)=>n===first?base:n===first+step?base+4:n>first+step&&(n-first)%step===0?base+8:48;
export function buildNews(records,list=players,top=[]){
 const names=list.map(p=>p.name),ladder=new Map(top.map((e,i)=>[e.puuid,{pos:i+1,lp:e.lp,tier:e.tier}]));
 const valid=r=>r.queue==='solo'&&Array.isArray(r.stats)&&r.stats.length===2&&r.stats.every(s=>s&&[s.kills,s.deaths,s.assists].every(Number.isFinite))&&((r.kind==='opponents'&&(r.winner===0||r.winner===1))||(r.kind==='teammates'&&typeof r.teamWon==='boolean'));
 const games=records.filter(valid).sort((a,b)=>a.at.localeCompare(b.at));
 const articles=[],used={},faces=new Map();
 const h2h={wins:[0,0],streak:{who:null,n:0},pairs:new Map(),days:new Map(),count:0,last:null};
 let duoStreak={won:null,n:0},lastType={h2h:null,duo:null,feature:null};
 const write=(game,angle,others,at,hero,heroId,tag)=>{
  const story=STORIES[angle.type];
  used[angle.type]=(used[angle.type]??textSeed(angle.type))+1;const k=used[angle.type];
  const facts=[];
  for(const o of others){const f=STORIES[o.type].fact&&fillText(STORIES[o.type].fact,o.v);if(f&&!facts.includes(f)&&o.type!==angle.type)facts.push(f);if(facts.length===3)break;}
  if(angle.facts)facts.unshift(...angle.facts);
  const m=game&&{id:game.id,kind:game.kind,at:game.at,duration:game.duration,champions:game.champions.map(championName),championIds:game.stats.map(s=>s.championId??null),kda:game.stats.map(kdaText),winner:game.winner??null,teamWon:game.teamWon??null};
  articles.push({id:(game?.id||'')+':'+angle.type+(angle.key||''),at,tag,type:angle.type,score:angle.score,headline:fillText(story.h[k%story.h.length],angle.v),lede:fillText(story.lede[k%story.lede.length],angle.v),facts:facts.slice(0,4),hero,heroId,match:m});
  lastType[tag]=angle.type;
 };
 const choose=(angles,tag)=>{
  // Avoid running the same kind of headline twice in a row when another angle is close.
  for(const a of angles)a.rank=a.score-(a.type===lastType[tag]?12:0);
  angles.sort((a,b)=>b.rank-a.rank||b.score-a.score);
  return angles[0]&&angles[0].score>=NEWS_THRESHOLD?angles[0]:null;
 };
 for(const g of games){
  const S=g.stats,CN=g.champions.map(championName),start=Date.parse(g.at),end=start+(g.duration||0)*1000,at=new Date(end).toISOString(),m=Math.round((g.duration||0)/60);
  const angles=[],add=(type,score,v)=>angles.push({type,score,v});
  const statAngles=(i,v,goodRes,badRes,penalty)=>{const s=S[i],pv={...v,P:names[i],C:CN[i],K:s.kills,D:s.deaths,A:s.assists,PK:kdaText(s),spree:s.spree,res:goodRes};
   if(s.penta>0)add('penta',100-penalty,pv);else if(s.quadra>0)add('quadra',78-penalty,pv);
   if(s.spree>=10)add('rampage',68+Math.min(8,s.spree-10)-penalty,pv);else if(s.kills>=15)add('killfest',66+Math.min(8,s.kills-15)-penalty,pv);
   if(badRes!==null&&s.deaths>=9&&s.kills<=2)add('nightmare',63+Math.min(6,s.deaths-9)-penalty,{...pv,res:badRes});
  };
  const star=(v,kind)=>{let best=null;for(const p of g.lobby||[]){const r=ladder.get(p.puuid);if(r&&r.pos<=25&&(!best||r.pos<best.r.pos))best={p,r};}if(!best)return;const sv={...v,name:best.p.name?best.p.name.split('#')[0]:'a top player',pos:best.r.pos,lp:best.r.lp.toLocaleString('en-US')};
   if(kind==='h2h'){const onWinner=best.p.with[g.winner];add(onWinner?'starwin':'starloss',50+Math.round((26-best.r.pos)/2.5),sv);}
   else{const ally=best.p.with[0];add(ally?(g.teamWon?'duostarwin':'duostarloss'):(g.teamWon?'duostarbeat':'duostarlost'),46+Math.round((26-best.r.pos)/2.5),sv);}
  };
  let tag;
  if(g.kind==='opponents'){
   tag='h2h';const w=g.winner,l=1-w;h2h.count++;h2h.wins[w]++;
   const series=names[0]+' '+h2h.wins[0]+'–'+h2h.wins[1]+' '+names[1];
   const v={W:names[w],L:names[l],WC:CN[w],LC:CN[l],WK:kdaText(S[w]),LK:kdaText(S[l]),m,S:series};
   if(h2h.streak.who===l&&h2h.streak.n>=3)add('snap',80+3*h2h.streak.n,{...v,n:h2h.streak.n,nw:numberWord(h2h.streak.n)});
   h2h.streak=h2h.streak.who===w?{who:w,n:h2h.streak.n+1}:{who:w,n:1};
   if(h2h.streak.n>=3)add('streak',streakScore(h2h.streak.n,3,2,62),{...v,n:h2h.streak.n,nw:numberWord(h2h.streak.n)});
   const lead=x=>x[0]===x[1]?null:x[0]>x[1]?0:1,before=[...h2h.wins];before[w]--;
   if(h2h.count===1)add('first',68,v);
   else if(h2h.count>=4&&lead(before)===l&&lead(h2h.wins)===null)add('level',66,{...v,a:h2h.wins[0]});
   else if(h2h.count>=4&&lead(before)!==w&&lead(h2h.wins)===w)add('lead',75,{...v,a:h2h.wins[w],b:h2h.wins[l]});
   if([10,25,50,75,100].includes(h2h.count))add('milestone',58,{...v,n:h2h.count});
   const pk=g.champions.join('|'),pair=h2h.pairs.get(pk)||[0,0];pair[w]++;h2h.pairs.set(pk,pair);const pn=pair[0]+pair[1];
   if(pn>=3)add('pair',48+Math.min(pn,6),{...v,n:pn,nth:ordinal(pn),pa:pair[w],pb:pair[l]});
   for(const i of [0,1])statAngles(i,v,i===w?' to beat '+names[l]:' and still lost to '+names[w],i===w?' and still won':' as '+names[w]+' took the win',0);
   if(kdaRatio(S[l])>=3&&S[l].kills>=5&&kdaRatio(S[l])>kdaRatio(S[w])*1.5)add('kdalie',70,v);
   if(S[w].kills===0&&S[w].assists>=15)add('nokills',62,{...v,A:S[w].assists});
   if(g.surrender&&m<=22)add('ff',52,v);
   if(m>=38)add('marathon',50,v);
   if(h2h.last&&start-h2h.last.end>=30*864e5)add('gap',55,{...v,days:Math.round((start-h2h.last.end)/864e5)});
   if(h2h.last&&h2h.last.winner===l&&start-h2h.last.end<3*36e5)add('revenge',57,v);
   const day=g.at.slice(0,10),dn=(h2h.days.get(day)||0)+1;h2h.days.set(day,dn);
   if(dn>=3)add('sameday',52,{...v,dn,nth:ordinal(dn)});
   star(v,'h2h');
   h2h.last={end,winner:w};
  }else{
   tag='duo';const v={A:names[0],B:names[1],AC:CN[0],BC:CN[1],AK:kdaText(S[0]),BK:kdaText(S[1]),m};
   if(g.teamWon&&duoStreak.won===false&&duoStreak.n>=4)add('duosnap',60+2*Math.min(duoStreak.n,8),{...v,n:duoStreak.n});
   duoStreak=duoStreak.won===g.teamWon?{won:g.teamWon,n:duoStreak.n+1}:{won:g.teamWon,n:1};
   const n=duoStreak.n,nv={...v,n,nw:numberWord(n),NW:numberWord(n).replace(/^./,c=>c.toUpperCase())};
   if(g.teamWon&&n>=4)add('duowin',streakScore(n,4,3,60),nv);
   if(!g.teamWon&&n>=4)add('duoloss',streakScore(n,4,3,60),nv);
   for(const i of [0,1])statAngles(i,v,g.teamWon?' in a duo win':' and the duo still lost',null,6);
   star(v,'duo');
  }
  // Pick the headline; the next best angles become supporting facts.
  const pick=choose(angles,tag);
  const heroOf=a=>{const i=a.v.P===names[1]?1:a.v.P===names[0]?0:g.kind==='opponents'?(['kdalie','starloss'].includes(a.type)?1-g.winner:g.winner):kdaRatio(S[1])>kdaRatio(S[0])?1:0;return [g.champions[i],S[i].championId??null];};
  if(pick)write(g,pick,angles.filter(a=>a!==pick).sort((a,b)=>b.score-a.score),at,...heroOf(pick),tag);
  // Familiar faces: people who keep turning up in their shared games.
  for(const p of g.lobby||[]){
   if(!p.puuid)continue;const f=faces.get(p.puuid)||{name:p.name,seen:0,side:[0,0],ally:[[0,0],[0,0]],enemy:[[0,0],[0,0]]};
   f.name=p.name||f.name;f.seen++;f.champion=p.champion;f.championId=p.championId;
   if(g.kind==='opponents'){const i=p.with[0]?0:1,sideWon=g.winner===i;f.side[sideWon?0:1]++;f.ally[i][sideWon?0:1]++;f.enemy[1-i][sideWon?1:0]++;}
   else for(const i of [0,1])(p.with[i]?f.ally:f.enemy)[i][g.teamWon?0:1]++;
   faces.set(p.puuid,f);
   if(![3,5,8,12,20].includes(f.seen)||!f.name)continue;
   const cands=[];
   if(won(f.side)>=2&&f.side[0]===0)cands.push({type:'facecurse',g:won(f.side)});
   if(won(f.side)>=2&&f.side[1]===0)cands.push({type:'facecharm',g:won(f.side)});
   for(const i of [0,1]){
    if(won(f.ally[i])>=2&&f.ally[i][0]===0)cands.push({type:'faceallyloss',g:won(f.ally[i]),X:names[i]});
    if(won(f.ally[i])>=2&&f.ally[i][1]===0)cands.push({type:'faceallywin',g:won(f.ally[i]),X:names[i]});
    if(won(f.enemy[i])>=2&&f.enemy[i][0]===0)cands.push({type:'facenemesis',g:won(f.enemy[i]),X:names[i]});
    if(won(f.enemy[i])>=2&&f.enemy[i][1]===0)cands.push({type:'facevictim',g:won(f.enemy[i]),X:names[i]});
   }
   cands.sort((a,b)=>b.g-a.g);const c=cands[0]||{type:'face',g:0};
   const score=c.type==='face'?(f.seen>=5?58:50):c.g>=3?76:50;
   if(score<NEWS_THRESHOLD||(f.told&&(f.told.type===c.type||c.type==='face')&&c.g<f.told.g+2))continue;
   f.told={type:c.type,g:c.g};
   const facts=[];if(won(f.side))facts.push('Their side in head-to-heads: '+f.side[0]+'–'+f.side[1]+'.');
   for(const i of [0,1]){if(won(f.ally[i]))facts.push('With '+names[i]+': '+f.ally[i][0]+'–'+f.ally[i][1]+'.');if(won(f.enemy[i]))facts.push('Against '+names[i]+': '+f.enemy[i][0]+'–'+f.enemy[i][1]+'.');}
   write(g,{type:c.type,score,key:':'+f.seen+':'+textSeed(p.puuid),facts:facts.slice(0,4),v:{name:f.name.split('#')[0],seen:f.seen,nth:ordinal(f.seen),sw:f.side[0],sl:f.side[1],g:c.g,X:c.X}},[],new Date(end+1000).toISOString(),p.champion,p.championId,'feature');
  }
 }
 const versus=games.filter(g=>g.kind==='opponents');
 return {
  articles:articles.sort((a,b)=>b.at.localeCompare(a.at)||b.score-a.score).slice(0,60),
  results:versus.slice().reverse().slice(0,20).map(g=>({id:g.id,at:g.at,duration:g.duration,winner:g.winner,champions:g.champions.map(championName),championIds:g.stats.map(s=>s.championId??null),kda:g.stats.map(kdaText)})),
  series:{wins:h2h.wins,total:h2h.count,streak:h2h.streak,form:versus.slice(-10).map(g=>g.winner)},
  faces:[...faces.values()].filter(f=>f.seen>=3&&f.name).sort((a,b)=>b.seen-a.seen).slice(0,8).map(f=>({name:f.name,seen:f.seen,side:f.side,ally:f.ally,enemy:f.enemy,championId:f.championId??null})),
  gamesRead:games.length
 };
}
async function news(request,env){
 if(request.method!=='GET')return json({error:'Use GET.'},405);
 if(!env?.BUCKET)return json({error:'Shared storage is unavailable.'},503);
 const season=new Date().getUTCFullYear();
 const stored=await env.BUCKET.get('matchups-all.json')||await env.BUCKET.get('matchups-'+season+'.json');
 const state=stored?await stored.json():{records:[]};
 const apex=await env.BUCKET.get('apex-top.json'),ladder=apex?await apex.json():null;
 const pending=state.records.filter(r=>['opponents','teammates'].includes(r.kind)&&r.statsVersion!==RECORD_VERSION&&!r.detailsUnavailable).length;
 return json({...buildNews(state.records,players,ladder?.top||[]),pending,ladderAt:ladder?.at||null,generatedAt:new Date().toISOString()});
}
export default {async fetch(request,env){const u=new URL(request.url);if(u.pathname==='/api/challenger')return challenger(request,env);if(u.pathname==='/api/matchups')return matchups(request,env);if(u.pathname==='/api/live')return live(request,env);if(u.pathname==='/api/news')return news(request,env);if(u.pathname==='/api/history'){const items=env?.BUCKET?await env.BUCKET.list({prefix:'snapshots/',limit:1000}):{objects:[]};const rows=await Promise.all(items.objects.map(async o=>(await env.BUCKET.get(o.key)).json()));return json({snapshots:rows});}if(u.pathname==='/api/stats'){
 if(request.method!=='POST')return json({error:'Use POST.'},405);
 if(request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return json({error:'Origin rejected.'},403);
 const key=env?.RIOT_API_KEY;
 const cached=env?.BUCKET?await env.BUCKET.get('latest.json'):null;const current=cached?await cached.json():null;if(current&&Date.now()-Date.parse(current.at)<300000&&!(u.searchParams.get('fresh')==='1'&&Date.now()-Date.parse(current.at)>=30000))return json(current);if(inFlight)return inFlight;
 if(!key||!/^RGAPI-[a-zA-Z0-9-]{20,100}$/.test(key))return json({error:'Connect a valid Riot API key first.'},400);
 inFlight=(async()=>{try{const stats=await Promise.all(players.map(async p=>{const a=await riot('https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/'+encodeURIComponent(p.name)+'/'+p.tag,key);const entries=await riot('https://eun1.api.riotgames.com/lol/league/v4/entries/by-puuid/'+encodeURIComponent(a.puuid),key);return Object.fromEntries(['solo','flex'].map((q,i)=>{const e=entries.find(e=>e.queueType===(i?'RANKED_FLEX_SR':'RANKED_SOLO_5x5'));return [q,e?{tier:e.tier,rank:e.rank,lp:e.leaguePoints,wins:e.wins,losses:e.losses}:{tier:'UNRANKED',rank:'',lp:0,wins:0,losses:0}]}));}));const result={at:new Date().toISOString(),source:'Riot API',queues:{solo:stats.map(p=>p.solo),flex:stats.map(p=>p.flex)}};if(env?.BUCKET){await env.BUCKET.put('snapshots/'+String(9999999999999-Date.parse(result.at))+'.json',JSON.stringify(result));await env.BUCKET.put('latest.json',JSON.stringify(result));}return json(result);}catch(e){return json({error:e.message},e.status||502);}finally{inFlight=null;}})();return inFlight;}
 if(['/news','/news/'].includes(u.pathname))return new Response(newsHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
 if(['/live','/live/'].includes(u.pathname))return new Response(liveHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
 if(['/whos-fault','/whos-fault/'].includes(u.pathname))return new Response(faultHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
 if(u.pathname!=='/')return new Response('Not found',{status:404});return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}};
const html=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Schizo Battle — Respectful Jew vs regelepetras2006. Solo/Duo LP, win rate and head-to-head results."><title>Schizo Battle</title><style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');
.site-nav{display:flex;align-items:center;gap:18px}.site-nav a{text-decoration:none;color:var(--muted);font-size:12px}.site-nav a[aria-current]{color:var(--a)}@media(max-width:650px){.header-inner{flex-wrap:wrap}.site-nav{gap:14px}}:root{color-scheme:dark;--bg:#0b1013;--panel:#121a1f;--line:#2a363c;--muted:#a3b0b7;--a:#b9ec69;--b:#bcafff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#edf1ed;font:14px 'DM Sans',sans-serif}button,a,select{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--a);outline-offset:4px}a{color:inherit}header{border-bottom:1px solid var(--line)}.header-inner{max-width:1200px;margin:auto;padding:24px 30px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font:700 30px 'Barlow Condensed';letter-spacing:.5px;text-transform:uppercase}.brand span{color:var(--a)}.queue{color:var(--muted);font-size:12px;margin:4px 0 0}.btn{padding:10px 15px;border:1px solid #3a484f;border-radius:5px;background:transparent;color:#edf1ed;font-weight:600;font-size:12px}.primary{background:var(--a);color:#14200a;border-color:var(--a)}button:disabled{opacity:.6;cursor:default}[hidden]{display:none!important}main{max-width:1200px;margin:auto;padding:28px 30px 20px}h1,h2,h3,p{margin:0}h2{font:600 25px 'Barlow Condensed';letter-spacing:.3px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:20px}.panel{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:24px}.h2h-panel{background:linear-gradient(120deg,#1b2619,#121a1f 75%);border-color:#3d4e35;margin-bottom:22px}.h2h-score{display:grid;grid-template-columns:1fr auto 1fr;gap:20px;align-items:center}.who{font-size:13px;font-weight:600;overflow-wrap:anywhere}.h2h-player strong{display:block;font:700 56px/1.1 'Barlow Condensed';color:var(--a);margin:7px 0}.h2h-player:last-child{text-align:right}.h2h-player:last-child strong{color:var(--b)}.record{font-size:11px;color:var(--muted)}.h2h-total{text-align:center}.h2h-total b{font:600 32px 'Barlow Condensed';display:block;margin-bottom:5px}.h2h-total span{font-size:11px;color:var(--muted)}.h2h-bar{display:flex;height:7px;border-radius:5px;background:#2a343a;overflow:hidden;margin-top:22px}.h2h-bar span:first-child{background:var(--a)}.h2h-bar span:last-child{background:var(--b)}.scope{color:var(--muted);font-size:11px;line-height:1.7;margin-top:12px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:28px}.player{border-top:2px solid var(--c);background:linear-gradient(120deg,color-mix(in srgb,var(--c) 5%,#121a1f),#121a1f 80%)}.name{font:600 clamp(25px,3vw,33px) 'Barlow Condensed';overflow-wrap:anywhere}.tag{color:var(--muted);font:12px 'DM Sans';margin-left:7px}.rank-row{display:flex;align-items:baseline;gap:15px;margin:20px 0}.lp{font:600 52px/1 'Barlow Condensed';color:var(--c)}.lp small{font:12px 'DM Sans';color:var(--muted);margin-left:5px}.tier{color:var(--muted);font-size:12px;text-transform:capitalize}.climb{margin:0 0 20px}.climb strong{display:block;color:var(--c);font-size:14px;font-weight:600}.climb small{display:block;color:var(--muted);font-size:11px;margin-top:5px}.stats{border-top:1px solid var(--line);padding-top:18px;display:flex;justify-content:space-between;gap:15px}.label{color:var(--muted);font-size:11px}.stat{display:block;font-size:22px;margin-top:7px;font-weight:600}.stat small{font-size:12px;font-weight:400;color:var(--muted)}.controls{display:flex;gap:6px}.controls button{padding:7px 12px;font-size:11px}.controls .active{border-color:var(--a);color:var(--a)}.legend{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:18px;font-size:12px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--a);margin-right:7px}.chart{height:340px;position:relative}.cutoff-key{margin-left:auto;color:#c2a56b;font-size:10px}.rank-marker image{filter:drop-shadow(0 0 5px #0009)}.chart svg{width:100%;height:100%}.chart-empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--muted);font-size:13px}.chart-note{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6}.error{color:#ffc3ad;font-size:12px;margin-bottom:20px;line-height:1.6}footer{color:#7f9099;font-size:10px;padding:24px 0 0;line-height:1.6}@media(max-width:650px){.header-inner{padding:18px 20px}.brand{font-size:27px}main{padding:20px}.panel{padding:20px}.cards{grid-template-columns:1fr;gap:15px}.h2h-score{gap:10px}.h2h-player strong{font-size:44px}.who{font-size:11px}.h2h-total b{font-size:27px}.h2h-total span{font-size:10px}.section-head{flex-wrap:wrap}.chart{height:290px}.legend{gap:12px;font-size:10px}}
.champion-section{margin-bottom:28px}.champion-section>h2{margin-bottom:16px} .champion-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.champion-panel{padding:0;overflow:hidden;border-top:2px solid var(--c)}.champion-heading{padding:20px;border-bottom:1px solid var(--line)}.champion-heading h3{color:var(--c);font:600 25px 'Barlow Condensed';overflow-wrap:anywhere}.champion-row{padding:16px 20px;border-bottom:1px solid var(--line)}.champion-row:last-child{border-bottom:0}.champion-row-top{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:10px}.champion-icon{height:40px;width:40px;border-radius:5px;background:#28343b;overflow:hidden;display:grid;place-items:center;color:var(--c);font-weight:700}.champion-icon img{width:40px;height:40px;object-fit:cover}.champion-name{font-weight:700;font-size:13px;overflow-wrap:anywhere}.champion-kda{font-size:11px;color:var(--muted);margin-top:5px}.champion-kda b{color:var(--c)}.champion-result{text-align:right;font-size:13px;font-weight:700}.champion-result small{display:block;color:var(--muted);font-size:10px;font-weight:400;margin-top:5px}.champion-empty{padding:24px 20px;color:var(--muted);font-size:12px;line-height:1.7}@media(max-width:800px){.champion-grid{grid-template-columns:1fr}}@media(max-width:400px){.champion-row,.champion-heading{padding:15px}}
</style></head><body><header><div class="header-inner"><div><h1 class="brand">Schizo <span>Battle</span></h1><p class="queue">Ranked Solo / Duo · EUNE</p></div><nav class="site-nav" aria-label="Main navigation"><a href="/" aria-current="page">Overview</a><a href="/news/">News</a><a href="/live/">Live</a><a href="/whos-fault/">Who's fault?</a><button class="btn primary" id="refresh">Refresh</button></nav></div></header><main><p class="error" id="error" role="status" hidden></p><section class="panel h2h-panel" aria-labelledby="h2h-title"><div class="section-head"><h2 id="h2h-title">Head-to-head</h2><button class="btn" id="scanOlder" hidden>Load older matches</button></div><div id="h2h" aria-live="polite"><p class="scope">Loading results…</p></div></section><section class="champion-section" aria-labelledby="champion-title"><h2 id="champion-title">Champions head-to-head</h2><div id="champion-stats" class="champion-grid" aria-live="polite"><p class="scope">Loading champion stats…</p></div></section><div class="cards" id="cards"></div><section aria-labelledby="chart-title"><div class="section-head"><h2 id="chart-title">LP over time</h2><div class="controls" aria-label="Time period"><button class="btn active" data-days="7">7 days</button><button class="btn" data-days="30">30 days</button><button class="btn" data-days="0">All</button></div></div><div class="panel"><div class="legend"><span><i class="dot"></i>Respectful Jew</span><span><i class="dot" style="background:var(--b)"></i>regelepetras2006</span><span class="cutoff-key" id="cutoff-key" hidden>Current cutoffs</span></div><div class="chart" id="chart"></div><p class="chart-note" id="chart-note"></p></div></section><footer>Not affiliated with Riot Games.</footer></main>
<script>const PLAYERS=${JSON.stringify(players)},INITIAL=${JSON.stringify(initial)};
const ARCHIVE=[{"player":0,"url":"https://op.gg/lol/summoners/eune/Respectful%20Jew-miy23","observations":[["2026-11-05",622],["2026-11-07",729],["2026-11-08",821],["2026-11-11",971],["2026-11-12",911],["2026-11-13",1031],["2026-11-14",1151],["2026-11-16",1151]]},{"player":1,"url":"https://op.gg/lol/summoners/eune/regelepetras2006-smrfm","observations":[["2026-11-07",1718],["2026-11-08",1742],["2026-11-09",1766],["2026-11-10",1638],["2026-11-13",1606],["2026-11-14",1553],["2026-11-16",1635]]}];
let days=7,busy=false,matchupBusy=false,matchupData=null,olderScanning=false,matchupTimer=null,challengerData=null;let data={solo:[]};
const $=id=>document.getElementById(id);const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>n.toLocaleString('en-US');const latest=()=>data.solo.at(-1);const wr=p=>p.wins+p.losses?100*p.wins/(p.wins+p.losses):null;
function showError(text){$('error').textContent=text;$('error').hidden=!text;}
function renderClimb(p){
 if(!challengerData||challengerData.stale||latest()?.source!=='Riot API'||!p||!['MASTER','GRANDMASTER','CHALLENGER'].includes(p.tier))return '';
 const gap=Math.max(0,challengerData.targetLp-p.lp),wins=Math.ceil(gap/30);
 const title='Current EUNE target: '+fmt(challengerData.targetLp)+' LP. Assumes +30 LP per win and no losses. Cutoff can change.';
 return '<div class="climb" title="'+esc(title)+'"><strong>'+(p.tier==='CHALLENGER'?'Challenger reached':gap?fmt(gap)+' LP to Challenger':'In range for Challenger')+'</strong>'+(gap&&p.tier!=='CHALLENGER'?'<small>≈'+wins+' '+(wins===1?'win':'wins')+' · +30 LP per win</small>':'')+'</div>';
}
async function loadChallenger(){
 try{const r=await fetch('/api/challenger');const d=await r.json();if(!r.ok||!Number.isFinite(d.targetLp))throw Error();challengerData=d;}catch{challengerData=null;}
 render();
}
function render(){const ps=latest()?.players||INITIAL.players;$('cards').innerHTML=ps.map((p,i)=>'<article class="panel player" style="--c:var(--'+(i?'b':'a')+')"><h2 class="name">'+PLAYERS[i].name+'<span class="tag">#'+PLAYERS[i].tag+'</span></h2><div class="rank-row"><div class="lp">'+(p&&p.tier!=='UNRANKED'?fmt(p.lp):'—')+'<small>LP</small></div><span class="tier">'+(p?esc(p.tier.toLowerCase())+(['MASTER','GRANDMASTER','CHALLENGER','UNRANKED'].includes(p.tier)?'':' '+esc(p.rank)):'Unranked')+'</span></div>'+renderClimb(p)+'<div class="stats"><div><span class="label">Season win rate</span><strong class="stat">'+(p&&wr(p)!==null?wr(p).toFixed(1)+'%':'—')+'</strong></div><div><span class="label">Wins / Losses</span><strong class="stat">'+(p?p.wins+' <small>/</small> '+p.losses:'—')+'</strong></div><div><span class="label">Games</span><strong class="stat">'+(p?fmt(p.wins+p.losses):'—')+'</strong></div></div></article>').join('');draw();renderMatchups();}
function draw(){
 const archived=ARCHIVE.flatMap(a=>a.observations.map(([date,lp])=>({at:date+'T00:00:00Z',dateOnly:date,source:'OP.GG',players:[0,1].map(i=>i===a.player?{lp,tier:'RECORDED'}:null)})));
 // Refreshes record a snapshot even when no LP changed; keep only the first and last reading of each unchanged run so idle stretches don't take up width.
 const lpKey=s=>s.players.map(p=>p&&p.tier!=='UNRANKED'?p.lp:'').join('/');
 const riot=data.solo.filter(s=>s.source==='Riot API').filter((s,k,a)=>k===0||k===a.length-1||lpKey(s)!==lpKey(a[k-1])||lpKey(s)!==lpKey(a[k+1]));
 const all=[...archived,...riot].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const ss=all.filter(s=>!days||Date.now()-Date.parse(s.at)<=days*86400000);
 $('chart-note').innerHTML=ss.some(s=>s.source==='OP.GG')?'Earlier readings: <a href="https://op.gg/lol/summoners/eune/Respectful%20Jew-miy23" target="_blank" rel="noopener">OP.GG</a>.':'';
 if(!ss.length){$('chart').innerHTML='<div class="chart-empty">No LP recorded for this period.</div>';return;}
 const value=(s,i)=>s.players[i]&&s.players[i].tier!=='UNRANKED'?s.players[i].lp:null;
 const ranks=challengerData&&!challengerData.stale?[{name:'Challenger',key:'challenger',icon:'https://cmsassets.rgpub.io/sanity/images/dsfx7636/news_live/90b96271598e5ca3ca2ceed26cd72f8bfe78f7b6-1088x871.png?w=128',lp:challengerData.targetLp,color:'#ddbb72'},{name:'Grandmaster',key:'grandmaster',icon:'https://cmsassets.rgpub.io/sanity/images/dsfx7636/news_live/e10270e43e31359f78d8ce6c33ee54a0d6f5d540-1088x871.png?w=128',lp:challengerData.grandmasterTargetLp,color:'#df877f'}].filter(r=>Number.isFinite(r.lp)):[];
 $('cutoff-key').hidden=!ranks.length;
 const vals=ss.flatMap(s=>[value(s,0),value(s,1)]).filter(v=>v!==null);
 if(!vals.length){$('chart').innerHTML='<div class="chart-empty">No ranked LP to show yet.</div>';return;}
 const range=[...vals,...ranks.map(r=>r.lp)],min=Math.min(...range),max=Math.max(...range),padding=Math.max(25,Math.ceil((max-min)*.15/25)*25),low=Math.max(0,Math.floor((min-padding)/50)*50),high=Math.ceil((max+padding)/50)*50;
 const R=ranks.length?725:795,W=R-65,start=Date.parse(ss[0].at),end=Date.parse(ss.at(-1).at),y=v=>225-(v-low)/(high-low)*190;
 // Square-root gap spacing: long gaps between daily readings shrink and dense live readings get room, while order stays chronological. Date ticks show the scale.
 const T=[...new Set(ss.map(s=>Date.parse(s.at)))],C=T.reduce((c,t,k)=>(c.push(k?c[k-1]+Math.sqrt(t-T[k-1]):0),c),[]),total=C.at(-1);
 const xt=t=>{if(!total)return 65+W/2;let k=0;while(k<T.length-2&&t>T[k+1])k++;const span=T[k+1]-T[k],f=span?Math.min(1,Math.max(0,(t-T[k])/span)):0;return Math.round((65+(C[k]+f*(C[k+1]-C[k]))/total*W)*10)/10;},x=s=>xt(Date.parse(s.at));
 let out='<svg viewBox="0 0 '+(ranks.length?1000:900)+' 280" role="img" aria-label="Both players’ LP over time"><title>Solo/Duo LP progression for both players</title><style>.pt{fill-opacity:0;transition:fill-opacity .12s}.pt:hover{fill-opacity:1}</style><text x="12" y="17" fill="#a3b0b7" font-size="12">LP</text>';
 for(let j=0;j<=4;j++){const v=low+(high-low)*j/4;out+='<line x1="65" x2="'+R+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#2a363c" stroke-dasharray="3 5"/><text x="50" y="'+(y(v)+4)+'" text-anchor="end" fill="#a3b0b7" font-size="12">'+Math.round(v)+'</text>';}
 if(ranks.length){
  const challenger=ranks.find(r=>r.key==='challenger'),gm=ranks.find(r=>r.key==='grandmaster');
  if(challenger)out+='<rect x="65" y="35" width="'+W+'" height="'+Math.max(0,y(challenger.lp)-35)+'" fill="#ddbb72" opacity=".045"/>';
  if(gm&&challenger)out+='<rect x="65" y="'+y(challenger.lp)+'" width="'+W+'" height="'+Math.max(0,y(gm.lp)-y(challenger.lp))+'" fill="#df877f" opacity=".035"/>';
  ranks.forEach((rank,index)=>{
   const lineY=y(rank.lp),other=ranks[1-index],badgeY=other&&Math.abs(lineY-y(other.lp))<42?lineY+(index?22:-22):lineY;
   out+='<g class="rank-marker" data-cutoff="'+rank.key+'"><title>Current EUNE '+rank.name+' target: '+fmt(rank.lp)+' LP</title><line x1="65" x2="'+R+'" y1="'+lineY+'" y2="'+lineY+'" stroke="'+rank.color+'" stroke-width="1.5" stroke-dasharray="7 6" opacity=".8"/>'+(badgeY!==lineY?'<path d="M'+R+' '+lineY+' L806 '+badgeY+'" fill="none" stroke="'+rank.color+'" opacity=".5"/>':'')+'<image data-rank-icon="'+rank.key+'" href="'+rank.icon+'" x="807" y="'+(badgeY-23)+'" width="46" height="46"/><text x="861" y="'+(badgeY-3)+'" fill="'+rank.color+'" font-size="12" font-weight="600">'+rank.name+'</text><text x="861" y="'+(badgeY+13)+'" fill="#a3b0b7" font-size="11">'+fmt(rank.lp)+' LP</text></g>';
  });
 }
 const ends=[];
 for(let i=0;i<2;i++){
  const pts=ss.filter(s=>value(s,i)!==null).map(s=>[x(s),y(value(s,i)),s]);const color=i?'#bcafff':'#b9ec69';
  if(pts.length>1)out+='<path data-player="'+i+'" d="'+pts.map((p,j)=>p?(j&&pts[j-1]?'L':'M')+p[0]+' '+p[1]:'').join(' ')+'" stroke="'+color+'" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" fill="none"/>';
  // Only the latest reading gets a visible dot; the rest are invisible hover targets that light up with their tooltip.
  pts.forEach((p,k)=>{const lastPt=k===pts.length-1;if(p)out+='<circle class="'+(lastPt?'pt-end':'pt')+'" cx="'+p[0]+'" cy="'+p[1]+'" r="'+(lastPt?5:7)+'" fill="'+color+'" stroke="#10171b" stroke-width="'+(lastPt?2:0)+'"><title>'+PLAYERS[i].name+': '+fmt(p[2].players[i].lp)+' LP · '+(p[2].dateOnly?p[2].dateOnly+' · OP.GG':new Date(p[2].at).toLocaleString())+'</title></circle>';});
  const last=pts.at(-1);if(last)ends.push({x:last[0]+9,y:last[1]+4,color,text:fmt(last[2].players[i].lp)+' LP'});
 }
 // End labels sit just right of each line's last point; nudge apart when they would overlap.
 if(ends.length===2&&Math.abs(ends[0].y-ends[1].y)<16&&Math.abs(ends[0].x-ends[1].x)<70){const[a,b]=ends[0].y<=ends[1].y?ends:[ends[1],ends[0]],mid=(a.y+b.y)/2;a.y=mid-8;b.y=mid+8;}
 ends.forEach(e=>{out+='<text x="'+e.x+'" y="'+e.y+'" fill="'+e.color+'" font-size="13" font-weight="600" paint-order="stroke" stroke="#10171b" stroke-width="4">'+e.text+'</text>';});
 const label=s=>new Date(s.at).toLocaleString(undefined,{month:'short',day:'numeric',...(end-start<86400000?{hour:'2-digit',minute:'2-digit'}:{})});
 out+='<text x="65" y="255" fill="#a3b0b7" font-size="12">'+label(ss[0])+'</text>'+(ss.length>1?'<text x="'+R+'" y="255" text-anchor="end" fill="#a3b0b7" font-size="12">'+label(ss.at(-1))+'</text>':'');
 if(end-start>=36*3600000){let prev=65;const d=new Date(start);d.setHours(24,0,0,0);for(;d.getTime()<end;d.setDate(d.getDate()+1)){const tx=xt(d.getTime()),dl=d.toLocaleDateString(undefined,{month:'short',day:'numeric'});if(tx-prev<55||R-tx<55||dl===label(ss.at(-1)))continue;prev=tx;out+='<line x1="'+tx+'" x2="'+tx+'" y1="226" y2="231" stroke="#3a474e"/><text x="'+tx+'" y="255" text-anchor="middle" fill="#7f8c93" font-size="11">'+dl+'</text>';}}
 out+='</svg>';$('chart').innerHTML=out;
 if(ss.length===1)$('chart-note').innerHTML='First reading — the lines will build as LP changes.';
}
function summarizeChampion(rows,i){
 const valid=v=>Number.isFinite(v)&&v>=0;
 const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
 const stats=rows.map(r=>r.stats?.[i]);
 const triples=rows.map((r,n)=>stats[n]||Object.fromEntries(['kills','deaths','assists'].map((k,j)=>[k,Number(String(r.kda?.[i]||'').split('/')[j]??NaN)]))).filter(s=>['kills','deaths','assists'].every(k=>valid(s[k])));
 const kills=triples.reduce((a,s)=>a+s.kills,0),deaths=triples.reduce((a,s)=>a+s.deaths,0),assists=triples.reduce((a,s)=>a+s.assists,0);
 const xp=stats.map(s=>s?.xp).filter(valid),cs=stats.map(s=>s?.cs).filter(valid),csm=rows.flatMap((r,n)=>valid(stats[n]?.cs)&&r.duration>0?[stats[n].cs/(r.duration/60)]:[]);
 return {games:rows.length,wins:rows.filter(r=>r.winner===i).length,kda:triples.length?(deaths?(kills+assists)/deaths:Infinity):null,kills:triples.length?kills/triples.length:null,deaths:triples.length?deaths/triples.length:null,assists:triples.length?assists/triples.length:null,cs:mean(cs),csm:mean(csm),xp:mean(xp),csGames:cs.length,xpGames:xp.length,championId:stats.find(s=>s?.championId)?.championId};
}
const championNumber=(n,d=1)=>n===null?'—':n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const championRatio=s=>s.kda===Infinity?'Perfect':championNumber(s.kda,2)+' KDA';
function renderChampions(rows){
 $('champion-stats').innerHTML=[0,1].map(i=>{
  const groups=[...new Set(rows.map(r=>r.champions[i]))].map(name=>({name,...summarizeChampion(rows.filter(r=>r.champions[i]===name),i)}));
  groups.sort((a,b)=>b.games-a.games||a.name.localeCompare(b.name));
  return '<article class="panel champion-panel" style="--c:var(--'+(i?'b':'a')+')"><div class="champion-heading"><h3>'+esc(PLAYERS[i].name)+'</h3></div>'+(groups.length?groups.map(s=>'<div class="champion-row"><div class="champion-row-top"><span class="champion-icon">'+(Number.isInteger(s.championId)&&s.championId>0?'<img src="https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/'+s.championId+'.png" alt="" loading="lazy" onerror="this.hidden=true">':esc(s.name.slice(0,1)))+'</span><div><div class="champion-name">'+esc(s.name)+'</div><div class="champion-kda"><b>'+championRatio(s)+'</b></div></div><div class="champion-result">'+(100*s.wins/s.games).toFixed(0)+'%<small>'+s.games+' '+(s.games===1?'game':'games')+'</small></div></div></div>').join(''):'<p class="champion-empty">No head-to-head games yet.</p>')+'</article>';
 }).join('');
}
function renderMatchups(){
 if(!matchupData)return;const d=matchupData,versus=d.records.filter(r=>r.queue==='solo'&&r.kind==='opponents'&&r.winner!==null).sort((a,b)=>b.at.localeCompare(a.at));
 const wins=[0,1].map(i=>versus.filter(r=>r.winner===i).length),total=versus.length,rates=wins.map(w=>total?(w/total*100).toFixed(1)+'%':'—');
 renderChampions(versus);
 $('h2h').innerHTML='<div class="h2h-score"><div class="h2h-player"><div class="who">'+PLAYERS[0].name+'</div><strong>'+rates[0]+'</strong><span class="record">'+wins[0]+' wins</span></div><div class="h2h-total"><b>'+wins[0]+' : '+wins[1]+'</b><span>'+total+' direct matchups</span></div><div class="h2h-player"><div class="who">'+PLAYERS[1].name+'</div><strong>'+rates[1]+'</strong><span class="record">'+wins[1]+' wins</span></div></div><div class="h2h-bar"><span style="width:'+(total?wins[0]/total*100:0)+'%"></span><span style="width:'+(total?wins[1]/total*100:0)+'%"></span></div><p class="scope" role="status">'+(matchupBusy||olderScanning?'Searching… · ':'')+d.counts.map(fmt).join(' / ')+' games searched'+(versus.length?' · Oldest matchup: '+new Date(versus.at(-1).at).toLocaleDateString():'')+(d.exhausted.every(Boolean)&&!d.pending?' · End of available history':'')+(d.pending?' · '+d.pending+' shared matches to check':'')+(d.error?' · '+esc(d.error):'')+'</p>';
 $('scanOlder').hidden=d.exhausted.every(Boolean)&&!d.pending&&!d.error;
 $('scanOlder').disabled=matchupBusy||olderScanning||Boolean(d.retryAt&&Date.parse(d.retryAt)>Date.now());
 $('scanOlder').textContent=olderScanning?'Searching…':d.error?'Retry search':'Load older matches';
}
async function loadMatchups(older=false,force=false){
 if(matchupBusy)return;clearTimeout(matchupTimer);matchupBusy=true;if(matchupData)renderMatchups();
 let next=null,delay=3000;
 try{
  const r=await fetch('/api/matchups'+(force?'?refresh=1':older?'?older=1':''),{method:'POST'});const d=await r.json();
  if(!r.ok)throw Error(d.error||'Match history unavailable.');
  matchupData=d;
  if(d.rateLimited&&d.retryAt&&(olderScanning||d.pending)){
   next=olderScanning;delay=Math.max(3000,Date.parse(d.retryAt)-Date.now()+1000);
  }else if(d.error){olderScanning=false;}
  else if(olderScanning&&(!d.exhausted.every(Boolean)||d.pending)){next=true;}
  else{olderScanning=false;if(d.pending)next=false;}
 }catch(e){
  olderScanning=false;
  if(matchupData){matchupData.error=e.message;matchupData.retryAt=null;}
  else{$('h2h').innerHTML='<p class="scope">'+esc(e.message)+'</p>';$('scanOlder').hidden=false;$('scanOlder').disabled=false;$('scanOlder').textContent='Retry search';$('champion-stats').innerHTML='<p class="scope">Match history unavailable.</p>';}
 }finally{
  matchupBusy=false;if(matchupData)renderMatchups();
  if(next!==null)matchupTimer=setTimeout(()=>loadMatchups(next),delay);
  else if(matchupData?.retryAt&&Date.parse(matchupData.retryAt)>Date.now())matchupTimer=setTimeout(renderMatchups,Date.parse(matchupData.retryAt)-Date.now()+1000);
 }
}
async function loadHistory(){const r=await fetch('/api/history');if(!r.ok)throw Error('LP history unavailable.');const h=await r.json();data={solo:h.snapshots.filter(s=>Array.isArray(s.queues?.solo)).sort((a,b)=>a.at.localeCompare(b.at)).map(s=>({at:s.at,source:s.source,players:s.queues.solo}))};}
async function refresh(force=false){if(busy)return;busy=true;loadChallenger();$('refresh').disabled=true;$('refresh').textContent='Refreshing…';try{const r=await fetch('/api/stats'+(force?'?fresh=1':''),{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not refresh.');await loadHistory();if(!data.solo.some(s=>s.at===d.at))data.solo.push({at:d.at,source:d.source,players:d.queues.solo});showError('');render();}catch(e){showError(e.message);}finally{busy=false;$('refresh').disabled=false;$('refresh').textContent='Refresh';}}
$('refresh').onclick=()=>{refresh(true);loadMatchups(false,true);};$('scanOlder').onclick=()=>{if(matchupBusy)return;olderScanning=true;loadMatchups(true);};document.querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>{days=Number(b.dataset.days);document.querySelectorAll('[data-days]').forEach(x=>x.classList.toggle('active',x===b));draw();});setInterval(()=>{if(!document.hidden){refresh();if(!olderScanning)loadMatchups();}},300000);render();loadHistory().then(render).catch(()=>{}).finally(refresh);loadMatchups();</script></body></html>`;
const faultHtml=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Duo losses and deeply unserious verdicts."><title>Who's fault is it? · Schizo Battle</title><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}
.fault-main{max-width:850px}.fault-intro{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:10px 0 28px}.fault-title{font:600 clamp(32px,6vw,46px)/1.1 'Barlow Condensed'}.fault-intro p{color:var(--muted);font-size:12px;margin-top:8px}.joke-label{color:var(--muted);font-size:10px;white-space:nowrap;border:1px solid var(--line);padding:6px 9px;border-radius:20px}.loss-feed{display:grid;gap:16px}.loss-card{padding:0;overflow:hidden;transition:border-color .18s ease,transform .18s ease;animation:card-in .3s ease both;animation-delay:calc(min(var(--order),5)*35ms)}.loss-card:hover{border-color:#435159;transform:translateY(-1px)}.loss-meta{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;border-bottom:1px solid var(--line);font-size:10px;color:var(--muted)}.defeat{color:#eda8a4;font-weight:600;display:inline-flex;align-items:center;gap:7px}.defeat:before{content:'';width:5px;height:5px;border-radius:50%;background:#d87973}.match-players{display:grid;grid-template-columns:1fr 1fr;gap:22px;padding:20px}.match-player{display:flex;align-items:center;gap:12px;min-width:0}.match-player:last-child{border-left:1px solid var(--line);padding-left:22px}.portrait{position:relative;display:grid;place-items:center;width:50px;height:50px;border:1px solid #3c4a50;border-radius:8px;overflow:hidden;background:#263139;flex-shrink:0;color:var(--c);font-weight:700}.portrait img{position:absolute;width:100%;height:100%;object-fit:cover}.match-player-info{min-width:0}.summoner{color:var(--c);font-size:10px;overflow-wrap:anywhere;margin-bottom:4px}.champion{font-size:14px;font-weight:600}.game-kda{display:flex;align-items:baseline;gap:6px;margin-top:7px;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}.game-kda .slash{font-size:11px;color:#64757d;font-weight:400}.game-kda .deaths{color:#eda8a4}.game-kda small{font-size:10px;color:var(--muted);font-weight:400;margin-left:6px}.match-verdict{padding:14px 20px;border-top:1px solid var(--line);border-left:3px solid var(--culprit);background:color-mix(in srgb,var(--culprit) 4%,var(--panel))}.match-verdict-right{text-align:right;border-left:0;border-right:3px solid var(--culprit)}.match-verdict strong{font-size:12px;color:var(--culprit);font-weight:600}.match-verdict p{color:#c1cbd0;font-size:12px;line-height:1.5;margin-top:5px}.feed-status{font-size:11px;color:var(--muted);margin-top:16px;line-height:1.6}.feed-skeleton{height:196px;background:linear-gradient(110deg,#121a1f 25%,#1a252b 45%,#121a1f 65%);background-size:200% 100%;animation:shimmer 1.5s ease infinite;border:1px solid var(--line);border-radius:8px}.empty-feed{padding:32px;text-align:center;color:var(--muted);font-size:13px}.retry{margin-top:12px}.loss-count{font-variant-numeric:tabular-nums}@keyframes card-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}@keyframes shimmer{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.loss-card,.feed-skeleton{animation:none}.loss-card{transition:none}}@media(max-width:540px){.fault-main{padding:20px 14px}.fault-intro{align-items:start;gap:10px;margin-bottom:20px}.match-players{padding:16px 14px;gap:12px}.match-player{gap:9px}.match-player:last-child{padding-left:12px}.portrait{width:40px;height:40px;border-radius:6px}.champion{font-size:12px}.game-kda{font-size:15px;gap:4px;flex-wrap:wrap}.game-kda small{font-size:9px;margin-left:3px}.loss-meta{padding:12px 14px}.match-verdict{padding:13px 14px}.summoner{font-size:9px}.joke-label{font-size:9px}}
</style></head><body><header><div class="header-inner"><a class="brand" href="/" style="text-decoration:none">Schizo <span>Battle</span></a><nav class="site-nav" aria-label="Main navigation"><a href="/">Overview</a><a href="/news/">News</a><a href="/live/">Live</a><a href="/whos-fault/" aria-current="page">Who's fault?</a></nav></div></header><main class="fault-main"><div class="fault-intro"><div><h1 class="fault-title">Who's fault is it?</h1><p id="loss-count" class="loss-count">Their losses. Our verdict.</p></div><span class="joke-label">Just for fun</span></div><section class="loss-feed" id="loss-feed" aria-label="Shared losses" aria-busy="true"><div class="feed-skeleton" aria-hidden="true"></div><div class="feed-skeleton" aria-hidden="true"></div><div class="feed-skeleton" aria-hidden="true"></div></section><p class="feed-status" id="feed-status" role="status"></p><button class="btn retry" id="retry" hidden>Try again</button><footer>Not affiliated with Riot Games.</footer></main><script>
const PLAYERS=${JSON.stringify(players)};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const verdicts=new Map();
function chooseBlame(random=Math.random){return Math.floor(random()*3)===0?0:1;}
function matchVerdict(match,random=Math.random){
 const key='duo-verdict-v2:'+match.id;
 if(verdicts.has(key))return verdicts.get(key);
 try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&[0,1].includes(saved.culprit)&&typeof saved.reason==='string'&&saved.reason.length<200){verdicts.set(key,saved);return saved;}}catch{}
 const culprit=chooseBlame(random);
 const reasonIndex=Math.floor(random()*6);
 let timestamp='14:32';
 if(culprit===1&&reasonIndex===3){
  const end=Math.max(1,Math.min(29*60,Math.floor(Number(match.duration)||1800)-1));
  const start=Math.min(8*60,end),second=start+Math.floor(random()*(end-start+1));
  timestamp=Math.floor(second/60)+':'+String(second%60).padStart(2,'0');
 }
 const reasons=culprit===0?["Missed Q.","Didn't ward enough.","Was AFK this game.","Gapped by enemy.","Hooked the wrong problem.","Saved every cooldown for next game."]:["Lost tempo doing nothing.","Ran it down on scuttle.","Didn't linear.","Lost focus at "+timestamp+'.',"Pathed into a different game.","Reset right before the objective."];
 const verdict={culprit,reason:reasons[reasonIndex]};verdicts.set(key,verdict);
 try{localStorage.setItem(key,JSON.stringify(verdict));}catch{}
 return verdict;
}
function gameKda(match,i){
 const stat=match.stats?.[i];
 const values=stat?[stat.kills,stat.deaths,stat.assists]:String(match.kda?.[i]||'').split('/').map(Number);
 if(values.length!==3||!values.every(n=>Number.isFinite(n)&&n>=0))return '<span>—</span>';
 const [k,d,a]=values,ratio=d?((k+a)/d).toFixed(2)+' KDA':'Perfect';
 return '<span>'+k+'</span><span class="slash">/</span><span class="deaths">'+d+'</span><span class="slash">/</span><span>'+a+'</span><small>'+ratio+'</small>';
}
function matchPlayer(match,i){
 const champion=match.champions?.[i]||'Unknown',id=match.stats?.[i]?.championId;
 const image=Number.isInteger(id)&&id>0?'<img src="https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/'+id+'.png" alt="'+esc(champion)+'" loading="lazy" onerror="this.hidden=true">':'';
 return '<div class="match-player" style="--c:var(--'+(i?'b':'a')+')"><span class="portrait"><span aria-hidden="true">'+esc(champion.slice(0,1))+'</span>'+image+'</span><div class="match-player-info"><p class="summoner">'+esc(PLAYERS[i].name)+'</p><h2 class="champion">'+esc(champion)+'</h2><div class="game-kda" aria-label="Kills, deaths, assists">'+gameKda(match,i)+'</div></div></div>';
}
function renderDuo(d){
 const together=d.records.filter(r=>r.queue==='solo'&&r.kind==='teammates');
 const losses=together.filter(r=>r.teamWon===false).sort((a,b)=>b.at.localeCompare(a.at));
 const incomplete=together.some(r=>typeof r.teamWon!=='boolean');
 $('loss-count').textContent=losses.length+' shared '+(losses.length===1?'loss':'losses');
 $('loss-feed').setAttribute('aria-busy',String(incomplete));
 $('feed-status').textContent=incomplete?'Checking duo games…':'';
 if(!losses.length){$('loss-feed').innerHTML=incomplete?'<div class="feed-skeleton" aria-hidden="true"></div>':'<div class="panel empty-feed">No shared losses found.</div>';return;}
 $('loss-feed').innerHTML=losses.map((match,index)=>{
  const v=matchVerdict(match),date=new Date(match.at).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}),minutes=Math.floor(match.duration/60),seconds=String(Math.floor(match.duration%60)).padStart(2,'0');
  return '<article class="panel loss-card" style="--order:'+index+';--culprit:var(--'+(v.culprit?'b':'a')+')" aria-label="Duo loss on '+esc(date)+'"><div class="loss-meta"><span class="defeat">Defeat</span><span><time datetime="'+esc(match.at)+'">'+esc(date)+'</time> · '+minutes+':'+seconds+'</span></div><div class="match-players">'+matchPlayer(match,0)+matchPlayer(match,1)+'</div><div class="match-verdict'+(v.culprit?' match-verdict-right':'')+'"><strong>'+esc(PLAYERS[v.culprit].name)+"'s fault.</strong><p>"+esc(v.reason)+'</p></div></article>';
 }).join('');
}
async function loadDuo(fill=false){
 $('retry').hidden=true;
 try{
  const r=await fetch('/api/matchups',fill?{method:'POST'}:undefined);const d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not load matches.');
  renderDuo(d);
  const missing=d.records.some(r=>r.queue==='solo'&&r.kind==='teammates'&&typeof r.teamWon!=='boolean');
  if(!d.error&&(d.pending||missing))setTimeout(()=>loadDuo(true),fill?3000:0);
  else if((d.pending||missing)&&d.rateLimited&&d.retryAt)setTimeout(()=>loadDuo(true),Math.max(3000,Date.parse(d.retryAt)-Date.now()+1000));
  if(d.error){$('feed-status').textContent=d.error;$('retry').hidden=false;}
 }catch(e){$('feed-status').textContent=e.message;$('retry').hidden=false;$('loss-feed').setAttribute('aria-busy','false');if(!$('loss-feed').querySelector('.loss-card'))$('loss-feed').innerHTML='';}
}
$('retry').onclick=()=>loadDuo(true);loadDuo();
</script></body></html>`;
const liveHtml=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Live games for Respectful Jew and regelepetras2006."><title>Live · Schizo Battle</title><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}
.live-main{max-width:1000px}.live-intro{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:10px 0 22px}.live-title{font:600 clamp(32px,6vw,46px)/1.1 'Barlow Condensed'}.live-sub{color:var(--muted);font-size:12px;margin-top:8px;font-variant-numeric:tabular-nums}
.status-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px}.status-pill{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;border:1px solid var(--line);border-left:3px solid var(--c);border-radius:8px;background:var(--panel)}.status-pill b{color:var(--c);font-weight:600;font-size:13px;overflow-wrap:anywhere}.status-pill span{font-size:11px;color:var(--muted);white-space:nowrap;display:inline-flex;align-items:center;gap:7px}.status-pill.on span{color:#f0b3ae}.status-pill.on span:before{content:'';width:7px;height:7px;border-radius:50%;background:#e2554c;box-shadow:0 0 0 0 #e2554c99;animation:pulse 1.6s ease infinite}
.live-feed{display:grid;gap:18px}.game-card{padding:0;overflow:hidden}.game-card.enter{animation:card-in .3s ease both}.game-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line)}.game-head h2{font:600 22px 'Barlow Condensed'}.game-head h2 em{font-style:normal;color:var(--c)}.game-meta{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--muted)}.game-timer{font:600 20px 'Barlow Condensed';color:#edf1ed;font-variant-numeric:tabular-nums}
.teams{display:grid;grid-template-columns:1fr 1fr}.team{padding:14px 16px 16px}.team+.team{border-left:1px solid var(--line)}.team-label{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:var(--tc);margin:0 4px 8px;font-weight:600}.row{display:grid;grid-template-columns:38px 18px minmax(0,1fr) auto;align-items:center;gap:9px;padding:6px 4px;border-radius:6px}.row.me{background:color-mix(in srgb,var(--c) 10%,transparent);box-shadow:inset 3px 0 0 var(--c);padding-left:8px}.champ{position:relative;width:38px;height:38px;border-radius:6px;overflow:hidden;background:#263139;display:grid;place-items:center;font-weight:700;color:var(--muted)}.champ img,.ban img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.spells{display:grid;gap:2px}.spells i{display:block;position:relative;width:18px;height:18px;border-radius:3px;background:#263139;overflow:hidden}.spells img{position:absolute;inset:0;width:100%;height:100%}.who{min-width:0}.who p{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row.me .who p{color:var(--c)}.who small{display:block;font-size:10px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rank{font-size:11px;text-align:right;color:#c1cbd0;font-variant-numeric:tabular-nums;white-space:nowrap}.rank small{display:block;color:var(--muted);font-size:9px;margin-top:2px}.bans{display:flex;gap:5px;margin:10px 4px 0;align-items:center;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}.ban{position:relative;width:22px;height:22px;border-radius:4px;overflow:hidden;background:#263139;filter:grayscale(1);opacity:.7}
.idle{padding:44px 24px;text-align:center}.idle h2{margin-bottom:8px}.idle p{color:var(--muted);font-size:13px}.live-status{font-size:11px;color:var(--muted);margin-top:16px;line-height:1.6}.feed-skeleton{height:420px;background:linear-gradient(110deg,#121a1f 25%,#1a252b 45%,#121a1f 65%);background-size:200% 100%;animation:shimmer 1.5s ease infinite;border:1px solid var(--line);border-radius:8px}
@keyframes card-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}@keyframes shimmer{to{background-position:-200% 0}}@keyframes pulse{70%{box-shadow:0 0 0 6px #e2554c00}100%{box-shadow:0 0 0 0 #e2554c00}}@media(prefers-reduced-motion:reduce){.game-card,.feed-skeleton,.status-pill.on span:before{animation:none}}
@media(max-width:760px){.teams{grid-template-columns:1fr}.team+.team{border-left:0;border-top:1px solid var(--line)}}@media(max-width:540px){.live-main{padding:20px 14px}.status-row{grid-template-columns:1fr}.game-head{padding:12px 14px;flex-wrap:wrap}.team{padding:12px 10px 14px}}
</style></head><body><header><div class="header-inner"><a class="brand" href="/" style="text-decoration:none">Schizo <span>Battle</span></a><nav class="site-nav" aria-label="Main navigation"><a href="/">Overview</a><a href="/news/">News</a><a href="/live/" aria-current="page">Live</a><a href="/whos-fault/">Who's fault?</a></nav></div></header><main class="live-main"><div class="live-intro"><div><h1 class="live-title">Live games</h1><p class="live-sub" id="live-sub">Checking who's in game…</p></div><button class="btn" id="live-refresh">Check now</button></div><div class="status-row" id="status-row"></div><section class="live-feed" id="live-feed" aria-live="polite" aria-busy="true"><div class="feed-skeleton" aria-hidden="true"></div></section><p class="live-status" id="live-status" role="status"></p><footer>Not affiliated with Riot Games.</footer></main><script>
const PLAYERS=${JSON.stringify(players)};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CDRAGON='https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const QUEUES={0:'Custom game',400:'Normal Draft',420:'Ranked Solo/Duo',430:'Normal Blind',440:'Ranked Flex',450:'ARAM',480:'Swiftplay',490:'Quickplay',700:'Clash',830:'Co-op vs AI',840:'Co-op vs AI',850:'Co-op vs AI',900:'ARURF',1700:'Arena',1900:'URF'};
const TIERS={IRON:'I',BRONZE:'B',SILVER:'S',GOLD:'G',PLATINUM:'P',EMERALD:'E',DIAMOND:'D',MASTER:'M',GRANDMASTER:'GM',CHALLENGER:'C'};
const DIVS={I:1,II:2,III:3,IV:4};
let live=null,fetchedAt=0,busy=false,pollTimer=null,shown=new Set(),champNames={},spellIcons={};
fetch(CDRAGON+'v1/champion-summary.json').then(r=>r.json()).then(list=>{for(const c of list)champNames[c.id]=c.name;if(live)render();}).catch(()=>{});
fetch(CDRAGON+'v1/summoner-spells.json').then(r=>r.json()).then(list=>{for(const s of list)if(s.iconPath)spellIcons[s.id]=CDRAGON+s.iconPath.replace('/lol-game-data/assets/','').toLowerCase();if(live)render();}).catch(()=>{});
function queueName(g){return QUEUES[g.queueId]||(g.gameMode?g.gameMode.charAt(0)+g.gameMode.slice(1).toLowerCase():'Game');}
function rankText(r){
 if(!r)return '';if(r.tier==='UNRANKED')return '<span class="rank">Unranked</span>';
 const short=TIERS[r.tier]||r.tier,apex=['MASTER','GRANDMASTER','CHALLENGER'].includes(r.tier);
 const games=(r.wins||0)+(r.losses||0),wr=games?Math.round(r.wins/games*100)+'% · '+games+'g':'';
 return '<span class="rank">'+esc(short+(apex?'':DIVS[r.rank]||''))+' '+esc(r.lp)+' LP'+(wr?'<small>'+wr+'</small>':'')+'</span>';
}
function elapsed(g,now=Date.now()){
 if(g.startedAt)return Math.max(0,Math.floor((now-Date.parse(g.startedAt))/1000));
 if(g.gameLength>0)return Math.floor(g.gameLength+(now-fetchedAt)/1000);
 return null;
}
function clock(s){return s===null?'Loading screen':Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function img(src,alt){return src?'<img src="'+esc(src)+'" alt="'+esc(alt)+'" loading="lazy" onerror="this.remove()">':'';}
function participantRow(p){
 const name=String(p.riotId||(p.bot?'Bot':'Hidden player')),parts=name.split('#'),champ=champNames[p.championId]||'Champion '+p.championId;
 const me=p.tracked!==null&&p.tracked!==undefined;
 return '<div class="row'+(me?' me':'')+'"'+(me?' style="--c:var(--'+(p.tracked?'b':'a')+')"':'')+'><span class="champ" title="'+esc(champ)+'">'+esc(champ.slice(0,1))+img(CDRAGON+'v1/champion-icons/'+p.championId+'.png',champ)+'</span><span class="spells">'+(p.spells||[]).map(id=>'<i>'+img(spellIcons[id],'Summoner spell')+'</i>').join('')+'</span><div class="who"><p>'+esc(parts[0])+'</p><small>'+esc(champ)+(parts[1]?' · #'+esc(parts[1]):'')+'</small></div>'+rankText(p.rank)+'</div>';
}
function teamBlock(g,teamId,label,color){
 const rows=g.participants.filter(p=>p.teamId===teamId),bans=g.bans.filter(b=>b.teamId===teamId);
 return '<div class="team" style="--tc:'+color+'"><div class="team-label"><span>'+label+'</span><span>'+rows.length+' players</span></div>'+rows.map(participantRow).join('')+(bans.length?'<div class="bans">Bans '+bans.map(b=>'<span class="ban" title="'+esc(champNames[b.championId]||'')+'">'+img(CDRAGON+'v1/champion-icons/'+b.championId+'.png','Banned champion')+'</span>').join('')+'</div>':'')+'</div>';
}
function gameTitle(g){
 if(g.tracked.length>1){
  const sides=g.tracked.map(i=>g.participants.find(p=>p.tracked===i)?.teamId);
  return sides[0]===sides[1]?'<em style="--c:var(--a)">Both</em> · playing together':'<em style="--c:var(--a)">Both</em> · against each other';
 }
 const i=g.tracked[0];return '<em style="--c:var(--'+(i?'b':'a')+')">'+esc(PLAYERS[i].name)+'</em>';
}
function gameCard(g){
 const teamIds=[...new Set(g.participants.map(p=>p.teamId))].sort((a,b)=>a-b);
 const named={100:['Blue side','#6fb3ff'],200:['Red side','#ff8a80']};
 const teams=teamIds.map((t,i)=>teamBlock(g,t,(named[t]||['Team '+(i+1)])[0],(named[t]||[0,'var(--muted)'])[1])).join('');
 return '<article class="panel game-card'+(shown.has(g.gameId)?'':' enter')+'" data-game="'+esc(g.gameId)+'"><div class="game-head"><h2>'+gameTitle(g)+'</h2><div class="game-meta"><span>'+esc(queueName(g))+'</span><span class="game-timer" data-timer="'+esc(g.gameId)+'">'+clock(elapsed(g))+'</span></div></div><div class="teams"'+(teamIds.length>2?' style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))"':'')+'>'+teams+'</div></article>';
}
function statusPills(d){
 return PLAYERS.map((p,i)=>{const g=d.games.find(g=>g.tracked.includes(i));return '<div class="status-pill'+(g?' on':'')+'" style="--c:var(--'+(i?'b':'a')+')"><b>'+esc(p.name)+'</b><span>'+(g?'In game · '+esc(queueName(g)):'Not in game')+'</span></div>';}).join('');
}
function render(){
 const d=live;if(!d)return;
 $('status-row').innerHTML=statusPills(d);
 $('live-feed').setAttribute('aria-busy','false');
 $('live-feed').innerHTML=d.games.length?d.games.map(gameCard).join(''):'<div class="panel idle"><h2>Nobody is in game</h2><p>This page checks again every 30 seconds while it is open.</p></div>';
 shown=new Set(d.games.map(g=>g.gameId));tick();
}
function tick(){
 if(!live)return;
 for(const g of live.games){const el=document.querySelector('[data-timer="'+g.gameId+'"]');if(el)el.textContent=clock(elapsed(g));}
 const age=Math.max(0,Math.round((Date.now()-Date.parse(live.at))/1000));
 $('live-sub').textContent=(live.games.length?live.games.length+(live.games.length===1?' live game':' live games'):'No live games')+' · checked '+(age<5?'just now':age+'s ago');
}
async function load(){
 if(busy)return;busy=true;$('live-refresh').disabled=true;
 try{
  const r=await fetch('/api/live');const d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not check live games.');
  live=d;fetchedAt=Date.now();render();
  $('live-status').textContent=d.stale?'Showing the last known result: '+(d.error||'Riot is unavailable.'):'';
 }catch(e){
  $('live-status').textContent=e.message;
  if(!live){$('live-feed').setAttribute('aria-busy','false');$('live-feed').innerHTML='<div class="panel idle"><h2>Live games unavailable</h2><p>'+esc(e.message)+'</p></div>';$('live-sub').textContent='Could not check right now';}
 }finally{busy=false;$('live-refresh').disabled=false;}
}
function schedule(){clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{if(!document.hidden)await load();schedule();},30000);}
$('live-refresh').onclick=()=>{load();schedule();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden){load();schedule();}});
setInterval(tick,1000);load();schedule();
</script></body></html>`;

const newsHtml=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Stories written automatically from every game Respectful Jew and regelepetras2006 share."><title>News · Schizo Battle</title><style>${html.match(/<style>([\s\S]*?)<\/style>/)[1]}
.news-intro{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:10px 0 22px}.news-title{font:600 clamp(32px,6vw,46px)/1.1 'Barlow Condensed'}.news-sub{color:var(--muted);font-size:12px;margin-top:8px}
.news-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}.who-a{color:var(--a)}.who-b{color:var(--b)}
.hero-card{position:relative;display:flex;align-items:flex-end;min-height:340px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#0f161a;animation:card-in .35s ease both}.hero-art{position:absolute;inset:0;background:radial-gradient(120% 90% at 80% 10%,#22303a,#0f161a)}.hero-art img{width:100%;height:100%;object-fit:cover;object-position:center 22%}.hero-art:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,16,19,.1) 15%,rgba(11,16,19,.78) 58%,#0b1013 100%)}
.hero-copy{position:relative;padding:26px 28px 24px;width:100%}.hero-headline{font:700 clamp(26px,3.6vw,40px)/1.05 'Barlow Condensed';margin:10px 0 10px;max-width:760px;text-wrap:balance}.hero-lede{color:#d5dde1;font-size:14px;line-height:1.55;max-width:680px}.hero-meta{display:block;color:var(--muted);font-size:11px;margin-top:12px}.hero-copy .facts{margin-top:12px}.hero-copy .match-line{background:rgba(11,16,19,.72);backdrop-filter:blur(4px)}
.story-tag{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--t)}.story-tag:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--t)}
.feed{margin-top:8px}.day-title{font:600 21px 'Barlow Condensed';margin:26px 0 10px}.day-list{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}.story+.story{border-top:1px solid var(--line)}
.story summary{list-style:none;display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:13px;align-items:center;padding:11px 16px;cursor:pointer;transition:background .15s ease}.story summary::-webkit-details-marker{display:none}.story summary:hover,.story[open] summary{background:#172228}
.story-icon{display:block;width:36px;height:36px;border-radius:6px;overflow:hidden;background:#263139;border:1px solid #34424a}.story-icon img{display:block;width:100%;height:100%;object-fit:cover}.story-text{display:flex;flex-direction:column;gap:3px;min-width:0}.story-headline{font-size:14px;font-weight:600;line-height:1.35}.story-time{color:var(--muted);font-size:11px;white-space:nowrap}
.story-body{padding:2px 16px 16px 65px;animation:card-in .2s ease both}.lede{color:#c9d2d6;font-size:13px;line-height:1.6}.facts{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:5px}.facts li{position:relative;padding-left:14px;font-size:12px;color:#b7c2c7;line-height:1.45}.facts li:before{content:'';position:absolute;left:0;top:6px;width:5px;height:5px;border-radius:1px;background:#52636b}
.match-line{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:center;margin-top:14px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:#0f161a;max-width:560px}.ml-player{display:flex;align-items:center;gap:9px;min-width:0}.ml-player:last-child{flex-direction:row-reverse;text-align:right}.ml-player img{width:30px;height:30px;border-radius:5px;flex-shrink:0}.ml-player>span{min-width:0}.ml-player b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ml-player small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.ml-player.lost{opacity:.55}.ml-mid{text-align:center;font:600 15px 'Barlow Condensed';color:var(--muted)}.ml-mid small{display:block;font:400 10px 'DM Sans';margin-top:2px;white-space:nowrap}
.news-side{display:grid;gap:18px}.side-box{border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}.side-title{font:700 11px 'DM Sans';letter-spacing:.8px;text-transform:uppercase;color:var(--muted);padding:12px 14px;border-bottom:1px solid var(--line);background:#151f25}
.series-score{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:16px 14px 6px;text-align:center}.series-score b{display:block;font:700 44px/1 'Barlow Condensed'}.series-score span{display:block;font-size:11px;margin-top:4px;overflow-wrap:anywhere}.series-score i{color:var(--muted);font-style:normal;font-size:20px}.form{display:flex;justify-content:center;gap:5px;padding:8px 14px 4px}.dot{width:9px;height:9px;border-radius:50%}.dot.a{background:var(--a)}.dot.b{background:var(--b)}.series-note{text-align:center;color:var(--muted);font-size:11px;padding:6px 14px 14px}
.result-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:9px 14px}.result-row+.result-row{border-top:1px solid var(--line)}.rr-p{grid-column:1;display:flex;align-items:center;gap:8px;font-size:12px;opacity:.5;min-width:0}.rr-p.won{opacity:1}.rr-p img{width:20px;height:20px;border-radius:4px}.rr-p span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rr-p b{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;font-size:11px}.result-row time{grid-column:2;grid-row:1/3;align-self:center;color:var(--muted);font-size:10px}
.face-row{display:grid;grid-template-columns:28px minmax(0,1fr);gap:10px;align-items:center;padding:10px 14px}.face-row+.face-row{border-top:1px solid var(--line)}.face-row img{width:28px;height:28px;border-radius:50%}.face-row b{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.face-row small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.side-empty{padding:14px;color:var(--muted);font-size:12px}
.empty-news{padding:44px 24px;text-align:center}.empty-news h2{margin-bottom:8px}.empty-news p{color:var(--muted);font-size:13px}.news-status{font-size:11px;color:var(--muted);margin-top:14px;line-height:1.6}.hero-skeleton{height:340px;border-radius:8px;border:1px solid var(--line);background:linear-gradient(110deg,#121a1f 25%,#1a252b 45%,#121a1f 65%);background-size:200% 100%;animation:shimmer 1.5s ease infinite}
@keyframes card-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes shimmer{to{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.hero-card,.story-body,.hero-skeleton{animation:none}}
@media(max-width:920px){.news-grid{grid-template-columns:1fr}}@media(max-width:540px){main.news-main{padding:20px 16px}.hero-card{min-height:300px}.hero-copy{padding:18px 16px}.story summary{grid-template-columns:30px minmax(0,1fr);gap:10px;padding:10px 12px}.story-icon{width:30px;height:30px}.story-time{grid-column:2;font-size:10px}.story-body{padding:2px 12px 14px}.match-line{gap:8px;padding:9px}.ml-player img{width:26px;height:26px}}
</style></head><body><header><div class="header-inner"><a class="brand" href="/" style="text-decoration:none">Schizo <span>Battle</span></a><nav class="site-nav" aria-label="Main navigation"><a href="/">Overview</a><a href="/news/" aria-current="page">News</a><a href="/live/">Live</a><a href="/whos-fault/">Who's fault?</a></nav></div></header><main class="news-main"><div class="news-intro"><div><h1 class="news-title">News</h1><p class="news-sub" id="news-sub">Written automatically from every game they share.</p></div></div><div class="news-grid"><div class="news-col"><section id="hero" aria-label="Top story"><div class="hero-skeleton" aria-hidden="true"></div></section><section class="feed" id="feed" aria-label="Latest news" aria-busy="true"></section><p class="news-status" id="news-status" role="status"></p></div><aside class="news-side"><section class="side-box"><h2 class="side-title">Head-to-head</h2><div id="series"><p class="side-empty">Loading…</p></div></section><section class="side-box"><h2 class="side-title">Results</h2><div id="results"></div></section><section class="side-box" id="faces-box" hidden><h2 class="side-title">Familiar faces</h2><div id="faces"></div></section></aside></div><footer>Not affiliated with Riot Games.</footer></main><script>
const PLAYERS=${JSON.stringify(players)};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CDRAGON='https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const TAGS={h2h:['Head-to-head','#ddbb72'],duo:['Duo','#6fb3ff'],feature:['Feature','#ff8a80']};
let news=null,busy=false,fills=0;
const icon=id=>Number.isInteger(id)&&id>0?CDRAGON+'v1/champion-icons/'+id+'.png':'';
const splash=name=>name?CDRAGON+'assets/characters/'+name.toLowerCase()+'/skins/base/images/'+name.toLowerCase()+'_splash_centered_0.jpg':'';
const img=(src,alt)=>src?'<img src="'+esc(src)+'" alt="'+esc(alt||'')+'" loading="lazy" onerror="this.remove()">':'';
// Colour each player's name wherever it appears in generated text.
function names(text){let out=esc(text);PLAYERS.forEach((p,i)=>{out=out.split(esc(p.name)).join('<span class="who-'+(i?'b':'a')+'">'+esc(p.name)+'</span>');});return out;}
const rtf=new Intl.RelativeTimeFormat('en',{numeric:'auto'});
function ago(at,now=Date.now()){const s=(Date.parse(at)-now)/1000;for(const [unit,size] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return rtf.format(Math.round(s/size),unit);return 'just now';}
function dayTitle(at,now=new Date()){const d=new Date(at),start=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime(),diff=Math.round((start(now)-start(d))/86400000);if(diff<=0)return "Today's news";if(diff===1)return "Yesterday's news";return d.toLocaleDateString(undefined,{weekday:'long',day:'numeric',month:'long'})+(d.getFullYear()===now.getFullYear()?'':' '+d.getFullYear());}
const tag=a=>{const t=TAGS[a.tag]||TAGS.h2h;return '<span class="story-tag" style="--t:'+t[1]+'">'+t[0]+'</span>';};
function matchLine(m){
 if(!m)return '';const lost=i=>m.kind==='opponents'?m.winner!==i:m.teamWon===false;
 const side=i=>'<span class="ml-player'+(lost(i)?' lost':'')+'">'+img(icon(m.championIds[i]),m.champions[i])+'<span><b class="who-'+(i?'b':'a')+'">'+esc(PLAYERS[i].name)+'</b><small>'+esc(m.champions[i])+' · '+esc(m.kda[i])+'</small></span></span>';
 const date=new Date(m.at).toLocaleDateString(undefined,{day:'numeric',month:'short'});
 return '<div class="match-line">'+side(0)+'<span class="ml-mid">'+(m.kind==='opponents'?'vs':m.teamWon?'Win':'Loss')+'<small>'+Math.round(m.duration/60)+' min · '+esc(date)+'</small></span>'+side(1)+'</div>';
}
const facts=a=>a.facts.length?'<ul class="facts">'+a.facts.map(f=>'<li>'+names(f)+'</li>').join('')+'</ul>':'';
function hero(a){return '<article class="hero-card"><div class="hero-art">'+(a.hero?'<img src="'+esc(splash(a.hero))+'" alt="" onerror="this.remove()">':'')+'</div><div class="hero-copy">'+tag(a)+'<h2 class="hero-headline">'+names(a.headline)+'</h2><p class="hero-lede">'+names(a.lede)+'</p>'+facts(a)+matchLine(a.match)+'<time class="hero-meta" datetime="'+esc(a.at)+'">'+ago(a.at)+'</time></div></article>';}
function story(a){return '<details class="story"><summary><span class="story-icon">'+img(icon(a.heroId),a.hero)+'</span><span class="story-text">'+tag(a)+'<span class="story-headline">'+names(a.headline)+'</span></span><time class="story-time" datetime="'+esc(a.at)+'">'+ago(a.at)+'</time></summary><div class="story-body"><p class="lede">'+names(a.lede)+'</p>'+facts(a)+matchLine(a.match)+'</div></details>';}
// The top story is the strongest of the latest few, so a big moment stays up front for a while.
function pickHero(list){return list.slice(0,6).reduce((best,a)=>a.score>best.score?a:best,list[0]);}
function series(s){
 if(!s.total)return '<p class="side-empty">No head-to-head games yet.</p>';
 const leader=s.streak.who;
 return '<div class="series-score"><div class="who-a"><b>'+s.wins[0]+'</b><span>'+esc(PLAYERS[0].name)+'</span></div><i>–</i><div class="who-b"><b>'+s.wins[1]+'</b><span>'+esc(PLAYERS[1].name)+'</span></div></div><div class="form" aria-label="Last '+s.form.length+' meetings, oldest first">'+s.form.map(w=>'<span class="dot '+(w?'b':'a')+'" title="'+esc(PLAYERS[w].name)+' won"></span>').join('')+'</div><p class="series-note">'+(s.streak.n>=2?esc(PLAYERS[leader].name)+' has won the last '+s.streak.n:'Last meeting went to '+esc(PLAYERS[leader].name))+'</p>';
}
function resultRow(r){const p=i=>'<div class="rr-p'+(r.winner===i?' won':'')+'">'+img(icon(r.championIds[i]),r.champions[i])+'<span class="who-'+(i?'b':'a')+'">'+esc(PLAYERS[i].name)+'</span><b>'+esc(r.kda[i])+'</b></div>';return '<div class="result-row">'+p(0)+p(1)+'<time datetime="'+esc(r.at)+'">'+esc(new Date(r.at).toLocaleDateString(undefined,{day:'numeric',month:'short'}))+'</time></div>';}
function faceRow(f){
 const parts=[];if(f.side[0]+f.side[1])parts.push('H2H side '+f.side[0]+'–'+f.side[1]);
 return '<div class="face-row">'+(img(icon(f.championId),'')||'<span></span>')+'<div><b>'+esc(f.name)+'</b><small>'+f.seen+' shared games'+(parts.length?' · '+parts.join(' · '):'')+'</small></div></div>';
}
function render(){
 const d=news;if(!d)return;const list=d.articles;
 $('feed').setAttribute('aria-busy','false');
 if(!list.length){$('hero').innerHTML='<div class="panel empty-news"><h2>No headlines yet</h2><p>Stories appear once they share a game worth writing about.</p></div>';$('feed').innerHTML='';}
 else{
  const top=pickHero(list);$('hero').innerHTML=hero(top);
  const groups=[];for(const a of list){if(a===top)continue;const t=dayTitle(a.at),g=groups.at(-1);if(g&&g.title===t)g.items.push(a);else groups.push({title:t,items:[a]});}
  $('feed').innerHTML=groups.map(g=>'<h2 class="day-title">'+esc(g.title)+'</h2><div class="day-list">'+g.items.map(story).join('')+'</div>').join('');
 }
 $('series').innerHTML=series(d.series);
 $('results').innerHTML=d.results.length?d.results.slice(0,8).map(resultRow).join(''):'<p class="side-empty">No results yet.</p>';
 $('faces-box').hidden=!d.faces.length;$('faces').innerHTML=d.faces.map(faceRow).join('');
 $('news-sub').textContent=list.length+(list.length===1?' story':' stories')+' from '+d.gamesRead+' shared games';
}
async function load(fill=false){
 if(busy)return;busy=true;let again=false;
 try{
  // POST lets the server pick up new games and finish reading match details before news is rebuilt.
  if(fill){fills++;await fetch('/api/matchups',{method:'POST'}).catch(()=>null);}
  const r=await fetch('/api/news');const d=await r.json();if(!r.ok)throw Error(d.error||'News is unavailable.');
  news=d;render();
  again=d.pending>0&&fills<40;
  $('news-status').textContent=again?'Reading match details… '+d.pending+' games left.':'';
 }catch(e){
  $('news-status').textContent=e.message;
  if(!news){$('feed').setAttribute('aria-busy','false');$('hero').innerHTML='<div class="panel empty-news"><h2>News unavailable</h2><p>'+esc(e.message)+'</p></div>';}
 }finally{busy=false;}
 if(again)setTimeout(()=>load(true),2500);
 else if(!fill&&fills===0)load(true);
}
setInterval(()=>{for(const t of document.querySelectorAll('time[datetime].story-time,time[datetime].hero-meta'))t.textContent=ago(t.getAttribute('datetime'));},60000);
load();
</script></body></html>`;
