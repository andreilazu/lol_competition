const players=[{name:'Respectful Jew',tag:'miy23',slug:'Respectful%2BJew-miy23'},{name:'regelepetras2006',tag:'smrfm',slug:'regelepetras2006-smrfm'}];
const initial={at:'2026-11-17T13:55:00Z',source:'Public snapshot · League of Graphs',players:[{tier:'GRANDMASTER',rank:'I',lp:1301,wins:397,losses:342},{tier:'GRANDMASTER',rank:'I',lp:1663,wins:285,losses:235}]};
let inFlight, matchupFlight;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function riot(url,key){const r=await fetch(url,{headers:{'X-Riot-Token':key},signal:AbortSignal.timeout(15000)});if(!r.ok){const e=new Error(({401:'Riot rejected this API key.',403:'The server’s Riot API key is invalid or expired. The site owner needs to replace it.',404:'Account or ranked data not found on EUNE.',429:'Riot rate limit reached. Please wait and retry.'})[r.status]||'Riot is temporarily unavailable. Please retry.');e.riotStatus=r.status;e.status=r.status===429?429:502;e.retryAfter=Math.max(5,Number(r.headers.get('Retry-After'))||120);throw e;}return r.json();}
async function accounts(env,key){const old=await env.BUCKET?.get('accounts.json');if(old)return old.json();const ids=await Promise.all(players.map(p=>riot('https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/'+encodeURIComponent(p.name)+'/'+p.tag,key)));await env.BUCKET?.put('accounts.json',JSON.stringify(ids));return ids;}
function publicMatchups(s){return {checkedAt:s.checkedAt,counts:s.ids.map(a=>a.length),exhausted:s.exhausted,pending:s.pending.length,records:s.records,season:s.season,historyScope:s.historyScope||'season',unavailable:s.unavailable?.length||0,rateLimited:Boolean(s.rateLimited),error:s.error||null,retryAt:s.retryAt||null};}
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
  state.pending=[...new Set([...state.pending,...state.records.filter(r=>r.kind==='opponents'&&r.statsVersion!==1).map(r=>r.id)])];
  if(state.retryAt&&Date.now()<Date.parse(state.retryAt))return json(publicMatchups(state));
  if(!env.RIOT_API_KEY)return json({error:'The server needs a Riot API key.'},503);
  const key=env.RIOT_API_KEY, aa=await accounts(env,key);const older=new URL(request.url).searchParams.get('older')==='1';
  if(!state.pending.length&&(older||!state.checkedAt||Date.now()-Date.parse(state.checkedAt)>300000)){
   for(let i=0;i<2;i++){
    if(older&&state.exhausted[i])continue;
    const start=older?state.offset[i]:0;
    const ids=await riot('https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/'+encodeURIComponent(aa[i].puuid)+'/ids?type=ranked'+(older?'&endTime='+state.scanEndTime:'')+'&start='+start+'&count=100',key);
    state.ids[i]=[...new Set([...state.ids[i],...ids])];if(older)state.offset[i]=start+ids.length;if(older||!state.checkedAt)state.exhausted[i]=ids.length<100;
    // Save each cursor so a rate limit on the other account cannot discard progress.
    await env.BUCKET.put('matchups-all.json',JSON.stringify(state));
   }
   const other=new Set(state.ids[1]),done=new Set(state.processed);state.pending=state.ids[0].filter(id=>other.has(id)&&!done.has(id));state.checkedAt=new Date().toISOString();
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
   const pp=aa.map(a=>info.participants.find(p=>p.puuid===a.puuid));
   if(pp.every(Boolean)&&[420,440].includes(info.queueId)){
    const duration=info.gameEndTimestamp?Math.round((info.gameEndTimestamp-info.gameStartTimestamp)/1000):info.gameDuration;
    const remake=duration<300||pp.some(p=>p.gameEndedInEarlySurrender);
    const kind=remake?'remake':pp[0].teamId===pp[1].teamId?'teammates':'opponents';
    const number=v=>Number.isFinite(v)&&v>=0?v:null;
    const record={id,queue:info.queueId===420?'solo':'flex',at:new Date(info.gameStartTimestamp).toISOString(),duration,kind,winner:pp[0].win===pp[1].win?null:pp[0].win?0:1,champions:pp.map(p=>p.championName),kda:pp.map(p=>[p.kills,p.deaths,p.assists].join('/')),statsVersion:1,stats:pp.map(p=>({championId:number(p.championId),kills:number(p.kills),deaths:number(p.deaths),assists:number(p.assists),cs:number(p.totalMinionsKilled)!==null&&number(p.neutralMinionsKilled)!==null?p.totalMinionsKilled+p.neutralMinionsKilled:null,xp:number(p.champExperience)}))};
    const existing=state.records.findIndex(r=>r.id===id);if(existing<0)state.records.push(record);else state.records[existing]=record;
   }
   if(!state.processed.includes(id))state.processed.push(id);state.pending.shift();
  }
  await env.BUCKET.put('matchups-all.json',JSON.stringify(state));return json(publicMatchups(state));
 }catch(e){if(state){state.error=e.message;state.rateLimited=e.status===429;state.retryAt=new Date(Date.now()+(e.status===429?e.retryAfter:30)*1000).toISOString();await env.BUCKET.put('matchups-all.json',JSON.stringify(state));return json(publicMatchups(state));}return json({error:e.message},e.status||502);}finally{matchupFlight=null;}})();return (await matchupFlight).clone();
}
export default {async fetch(request,env){const u=new URL(request.url);if(u.pathname==='/api/matchups')return matchups(request,env);if(u.pathname==='/api/history'){const items=env?.BUCKET?await env.BUCKET.list({prefix:'snapshots/',limit:1000}):{objects:[]};const rows=await Promise.all(items.objects.map(async o=>(await env.BUCKET.get(o.key)).json()));return json({snapshots:rows});}if(u.pathname==='/api/stats'){
 if(request.method!=='POST')return json({error:'Use POST.'},405);
 if(request.headers.get('Origin')&&request.headers.get('Origin')!==u.origin)return json({error:'Origin rejected.'},403);
 const key=env?.RIOT_API_KEY;
 const cached=env?.BUCKET?await env.BUCKET.get('latest.json'):null;const current=cached?await cached.json():null;if(current&&Date.now()-Date.parse(current.at)<300000)return json(current);if(inFlight)return inFlight;
 if(!key||!/^RGAPI-[a-zA-Z0-9-]{20,100}$/.test(key))return json({error:'Connect a valid Riot API key first.'},400);
 inFlight=(async()=>{try{const stats=await Promise.all(players.map(async p=>{const a=await riot('https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/'+encodeURIComponent(p.name)+'/'+p.tag,key);const entries=await riot('https://eun1.api.riotgames.com/lol/league/v4/entries/by-puuid/'+encodeURIComponent(a.puuid),key);return Object.fromEntries(['solo','flex'].map((q,i)=>{const e=entries.find(e=>e.queueType===(i?'RANKED_FLEX_SR':'RANKED_SOLO_5x5'));return [q,e?{tier:e.tier,rank:e.rank,lp:e.leaguePoints,wins:e.wins,losses:e.losses}:{tier:'UNRANKED',rank:'',lp:0,wins:0,losses:0}]}));}));const result={at:new Date().toISOString(),source:'Riot API',queues:{solo:stats.map(p=>p.solo),flex:stats.map(p=>p.flex)}};if(env?.BUCKET){await env.BUCKET.put('snapshots/'+String(9999999999999-Date.parse(result.at))+'.json',JSON.stringify(result));await env.BUCKET.put('latest.json',JSON.stringify(result));}return json(result);}catch(e){return json({error:e.message},e.status||502);}finally{inFlight=null;}})();return inFlight;}
 if(u.pathname!=='/')return new Response('Not found',{status:404});return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}};
const html=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Schizo Battle — Respectful Jew vs regelepetras2006. Solo/Duo LP, win rate and head-to-head results."><title>Schizo Battle</title><style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap');
:root{color-scheme:dark;--bg:#0b1013;--panel:#121a1f;--line:#2a363c;--muted:#a3b0b7;--a:#b9ec69;--b:#bcafff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#edf1ed;font:14px 'DM Sans',sans-serif}button,a,select{font:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--a);outline-offset:4px}a{color:inherit}header{border-bottom:1px solid var(--line)}.header-inner{max-width:1200px;margin:auto;padding:24px 30px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font:700 30px 'Barlow Condensed';letter-spacing:.5px;text-transform:uppercase}.brand span{color:var(--a)}.queue{color:var(--muted);font-size:12px;margin:4px 0 0}.btn{padding:10px 15px;border:1px solid #3a484f;border-radius:5px;background:transparent;color:#edf1ed;font-weight:600;font-size:12px}.primary{background:var(--a);color:#14200a;border-color:var(--a)}button:disabled{opacity:.6;cursor:default}[hidden]{display:none!important}main{max-width:1200px;margin:auto;padding:28px 30px 20px}h1,h2,h3,p{margin:0}h2{font:600 25px 'Barlow Condensed';letter-spacing:.3px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:20px}.panel{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:24px}.h2h-panel{background:linear-gradient(120deg,#1b2619,#121a1f 75%);border-color:#3d4e35;margin-bottom:22px}.h2h-score{display:grid;grid-template-columns:1fr auto 1fr;gap:20px;align-items:center}.who{font-size:13px;font-weight:600;overflow-wrap:anywhere}.h2h-player strong{display:block;font:700 56px/1.1 'Barlow Condensed';color:var(--a);margin:7px 0}.h2h-player:last-child{text-align:right}.h2h-player:last-child strong{color:var(--b)}.record{font-size:11px;color:var(--muted)}.h2h-total{text-align:center}.h2h-total b{font:600 32px 'Barlow Condensed';display:block;margin-bottom:5px}.h2h-total span{font-size:11px;color:var(--muted)}.h2h-bar{display:flex;height:7px;border-radius:5px;background:#2a343a;overflow:hidden;margin-top:22px}.h2h-bar span:first-child{background:var(--a)}.h2h-bar span:last-child{background:var(--b)}.scope{color:var(--muted);font-size:11px;line-height:1.7;margin-top:12px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:28px}.player{border-top:2px solid var(--c);background:linear-gradient(120deg,color-mix(in srgb,var(--c) 5%,#121a1f),#121a1f 80%)}.name{font:600 clamp(25px,3vw,33px) 'Barlow Condensed';overflow-wrap:anywhere}.tag{color:var(--muted);font:12px 'DM Sans';margin-left:7px}.rank-row{display:flex;align-items:baseline;gap:15px;margin:20px 0}.lp{font:600 52px/1 'Barlow Condensed';color:var(--c)}.lp small{font:12px 'DM Sans';color:var(--muted);margin-left:5px}.tier{color:var(--muted);font-size:12px;text-transform:capitalize}.stats{border-top:1px solid var(--line);padding-top:18px;display:flex;justify-content:space-between;gap:15px}.label{color:var(--muted);font-size:11px}.stat{display:block;font-size:22px;margin-top:7px;font-weight:600}.stat small{font-size:12px;font-weight:400;color:var(--muted)}.controls{display:flex;gap:6px}.controls button{padding:7px 12px;font-size:11px}.controls .active{border-color:var(--a);color:var(--a)}.legend{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:18px;font-size:12px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--a);margin-right:7px}.chart{height:300px;position:relative}.chart svg{width:100%;height:100%}.chart-empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--muted);font-size:13px}.chart-note{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6}.error{color:#ffc3ad;font-size:12px;margin-bottom:20px;line-height:1.6}footer{color:#7f9099;font-size:10px;padding:24px 0 0;line-height:1.6}@media(max-width:650px){.header-inner{padding:18px 20px}.brand{font-size:27px}main{padding:20px}.panel{padding:20px}.cards{grid-template-columns:1fr;gap:15px}.h2h-score{gap:10px}.h2h-player strong{font-size:44px}.who{font-size:11px}.h2h-total b{font-size:27px}.h2h-total span{font-size:10px}.section-head{flex-wrap:wrap}.chart{height:260px}.legend{gap:12px;font-size:10px}}
.champion-section{margin-bottom:28px}.champion-section>h2{margin-bottom:16px} .champion-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.champion-panel{padding:0;overflow:hidden;border-top:2px solid var(--c)}.champion-heading{padding:20px;border-bottom:1px solid var(--line)}.champion-heading h3{color:var(--c);font:600 25px 'Barlow Condensed';overflow-wrap:anywhere}.champion-row{padding:16px 20px;border-bottom:1px solid var(--line)}.champion-row:last-child{border-bottom:0}.champion-row-top{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:10px}.champion-icon{height:40px;width:40px;border-radius:5px;background:#28343b;overflow:hidden;display:grid;place-items:center;color:var(--c);font-weight:700}.champion-icon img{width:40px;height:40px;object-fit:cover}.champion-name{font-weight:700;font-size:13px;overflow-wrap:anywhere}.champion-kda{font-size:11px;color:var(--muted);margin-top:5px}.champion-kda b{color:var(--c)}.champion-result{text-align:right;font-size:13px;font-weight:700}.champion-result small{display:block;color:var(--muted);font-size:10px;font-weight:400;margin-top:5px}.champion-empty{padding:24px 20px;color:var(--muted);font-size:12px;line-height:1.7}@media(max-width:800px){.champion-grid{grid-template-columns:1fr}}@media(max-width:400px){.champion-row,.champion-heading{padding:15px}}
</style></head><body><header><div class="header-inner"><div><h1 class="brand">Schizo <span>Battle</span></h1><p class="queue">Ranked Solo / Duo · EUNE</p></div><button class="btn primary" id="refresh">Refresh</button></div></header><main><p class="error" id="error" role="status" hidden></p><section class="panel h2h-panel" aria-labelledby="h2h-title"><div class="section-head"><h2 id="h2h-title">Head-to-head</h2><button class="btn" id="scanOlder" hidden>Load older matches</button></div><div id="h2h" aria-live="polite"><p class="scope">Loading results…</p></div></section><section class="champion-section" aria-labelledby="champion-title"><h2 id="champion-title">Champions head-to-head</h2><div id="champion-stats" class="champion-grid" aria-live="polite"><p class="scope">Loading champion stats…</p></div></section><div class="cards" id="cards"></div><section aria-labelledby="chart-title"><div class="section-head"><h2 id="chart-title">LP over time</h2><div class="controls" aria-label="Time period"><button class="btn active" data-days="7">7 days</button><button class="btn" data-days="30">30 days</button><button class="btn" data-days="0">All</button></div></div><div class="panel"><div class="legend"><span><i class="dot"></i>Respectful Jew</span><span><i class="dot" style="background:var(--b)"></i>regelepetras2006</span></div><div class="chart" id="chart"></div><p class="chart-note" id="chart-note"></p></div></section><footer>Not affiliated with Riot Games.</footer></main>
<script>const PLAYERS=${JSON.stringify(players)},INITIAL=${JSON.stringify(initial)};
const ARCHIVE=[{"player":0,"url":"https://op.gg/lol/summoners/eune/Respectful%20Jew-miy23","observations":[["2026-11-05",622],["2026-11-07",729],["2026-11-08",821],["2026-11-11",971],["2026-11-12",911],["2026-11-13",1031],["2026-11-14",1151],["2026-11-16",1151]]},{"player":1,"url":"https://op.gg/lol/summoners/eune/regelepetras2006-smrfm","observations":[["2026-11-07",1718],["2026-11-08",1742],["2026-11-09",1766],["2026-11-10",1638],["2026-11-13",1606],["2026-11-14",1553],["2026-11-16",1635]]}];
let days=7,busy=false,matchupBusy=false,matchupData=null,olderScanning=false,matchupTimer=null;let data={solo:[]};
const $=id=>document.getElementById(id);const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>n.toLocaleString('en-US');const latest=()=>data.solo.at(-1);const wr=p=>p.wins+p.losses?100*p.wins/(p.wins+p.losses):null;
function showError(text){$('error').textContent=text;$('error').hidden=!text;}
function render(){const ps=latest()?.players||INITIAL.players;$('cards').innerHTML=ps.map((p,i)=>'<article class="panel player" style="--c:var(--'+(i?'b':'a')+')"><h2 class="name">'+PLAYERS[i].name+'<span class="tag">#'+PLAYERS[i].tag+'</span></h2><div class="rank-row"><div class="lp">'+(p&&p.tier!=='UNRANKED'?fmt(p.lp):'—')+'<small>LP</small></div><span class="tier">'+(p?esc(p.tier.toLowerCase())+(['MASTER','GRANDMASTER','CHALLENGER','UNRANKED'].includes(p.tier)?'':' '+esc(p.rank)):'Unranked')+'</span></div><div class="stats"><div><span class="label">Season win rate</span><strong class="stat">'+(p&&wr(p)!==null?wr(p).toFixed(1)+'%':'—')+'</strong></div><div><span class="label">Wins / Losses</span><strong class="stat">'+(p?p.wins+' <small>/</small> '+p.losses:'—')+'</strong></div><div><span class="label">Games</span><strong class="stat">'+(p?fmt(p.wins+p.losses):'—')+'</strong></div></div></article>').join('');draw();renderMatchups();}
function draw(){
 const archived=ARCHIVE.flatMap(a=>a.observations.map(([date,lp])=>({at:date+'T00:00:00Z',dateOnly:date,source:'OP.GG',players:[0,1].map(i=>i===a.player?{lp,tier:'RECORDED'}:null)})));
 const all=[...archived,...data.solo.filter(s=>s.source==='Riot API')].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const ss=all.filter(s=>!days||Date.now()-Date.parse(s.at)<=days*86400000);
 $('chart-note').innerHTML=ss.some(s=>s.source==='OP.GG')?'Earlier readings: <a href="https://op.gg/lol/summoners/eune/Respectful%20Jew-miy23" target="_blank" rel="noopener">OP.GG</a>.':'';
 if(!ss.length){$('chart').innerHTML='<div class="chart-empty">No LP recorded for this period.</div>';return;}
 const value=(s,i)=>s.players[i]&&s.players[i].tier!=='UNRANKED'?s.players[i].lp:null;
 const vals=ss.flatMap(s=>[value(s,0),value(s,1)]).filter(v=>v!==null);
 if(!vals.length){$('chart').innerHTML='<div class="chart-empty">No ranked LP to show yet.</div>';return;}
 const min=Math.min(...vals),max=Math.max(...vals),padding=Math.max(25,Math.ceil((max-min)*.15/25)*25),low=Math.max(0,Math.floor((min-padding)/50)*50),high=Math.ceil((max+padding)/50)*50;
 const start=Date.parse(ss[0].at),end=Date.parse(ss.at(-1).at),x=s=>65+(end===start?0.5:(Date.parse(s.at)-start)/(end-start))*730,y=v=>225-(v-low)/(high-low)*190;
 let out='<svg viewBox="0 0 900 280" role="img" aria-label="Both players’ LP over time"><title>Solo/Duo LP progression for both players</title><text x="12" y="17" fill="#a3b0b7" font-size="12">LP</text>';
 for(let j=0;j<=4;j++){const v=low+(high-low)*j/4;out+='<line x1="65" x2="795" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#2a363c" stroke-dasharray="3 5"/><text x="50" y="'+(y(v)+4)+'" text-anchor="end" fill="#a3b0b7" font-size="12">'+Math.round(v)+'</text>';}
 for(let i=0;i<2;i++){
  const pts=ss.filter(s=>value(s,i)!==null).map(s=>[x(s),y(value(s,i)),s]);const color=i?'#bcafff':'#b9ec69';
  if(pts.length>1)out+='<path data-player="'+i+'" d="'+pts.map((p,j)=>p?(j&&pts[j-1]?'L':'M')+p[0]+' '+p[1]:'').join(' ')+'" stroke="'+color+'" stroke-width="3" fill="none"/>';
  pts.forEach(p=>{if(p)out+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="'+color+'" stroke="#10171b" stroke-width="1"><title>'+PLAYERS[i].name+': '+fmt(p[2].players[i].lp)+' LP · '+(p[2].dateOnly?p[2].dateOnly+' · OP.GG':new Date(p[2].at).toLocaleString())+'</title></circle>';});
  const last=pts.filter(Boolean).at(-1);if(last)out+='<text x="'+(ss.length===1?last[0]+12:808)+'" y="'+(last[1]+(i&&value(ss.at(-1),0)!==null&&Math.abs(y(value(ss.at(-1),0))-last[1])<18?18:4))+'" fill="'+color+'" font-size="13" font-weight="600">'+fmt(last[2].players[i].lp)+' LP</text>';
 }
 const label=s=>new Date(s.at).toLocaleString(undefined,{month:'short',day:'numeric',...(end-start<86400000?{hour:'2-digit',minute:'2-digit'}:{})});
 out+='<text x="65" y="255" fill="#a3b0b7" font-size="12">'+label(ss[0])+'</text>'+(ss.length>1?'<text x="795" y="255" text-anchor="end" fill="#a3b0b7" font-size="12">'+label(ss.at(-1))+'</text>':'')+'</svg>';$('chart').innerHTML=out;
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
async function loadMatchups(older=false){
 if(matchupBusy)return;clearTimeout(matchupTimer);matchupBusy=true;if(matchupData)renderMatchups();
 let next=null,delay=3000;
 try{
  const r=await fetch('/api/matchups'+(older?'?older=1':''),{method:'POST'});const d=await r.json();
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
async function refresh(){if(busy)return;busy=true;$('refresh').disabled=true;$('refresh').textContent='Refreshing…';try{const r=await fetch('/api/stats',{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not refresh.');await loadHistory();if(!data.solo.some(s=>s.at===d.at))data.solo.push({at:d.at,source:d.source,players:d.queues.solo});showError('');render();}catch(e){showError(e.message);}finally{busy=false;$('refresh').disabled=false;$('refresh').textContent='Refresh';}}
$('refresh').onclick=()=>{refresh();loadMatchups();};$('scanOlder').onclick=()=>{if(matchupBusy)return;olderScanning=true;loadMatchups(true);};document.querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>{days=Number(b.dataset.days);document.querySelectorAll('[data-days]').forEach(x=>x.classList.toggle('active',x===b));draw();});setInterval(()=>{if(!document.hidden){refresh();if(!olderScanning)loadMatchups();}},300000);render();loadHistory().then(render).catch(()=>{}).finally(refresh);loadMatchups();</script></body></html>`;
