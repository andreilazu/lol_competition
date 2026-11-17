import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker/index.js';
const req=(path,method='GET')=>new Request('https://test.example'+path,{method});
const page=await worker.fetch(req('/'),{});const html=await page.text();assert.equal(page.status,200);new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
assert.equal((await worker.fetch(req('/api/stats','POST'),{})).status,400);
const store=new Map();const BUCKET={async get(k){return store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null;},async put(k,v){store.set(k,v);},async list(){return {objects:[...store.keys()].filter(k=>k.startsWith('snapshots/')).map(key=>({key}))};}};
let calls=0;globalThis.fetch=async(url)=>{calls++;return Response.json(url.includes('by-riot-id')?{puuid:'test'}:[{queueType:'RANKED_SOLO_5x5',tier:'MASTER',rank:'I',leaguePoints:230,wins:40,losses:20}]);};
const env={BUCKET,RIOT_API_KEY:'RGAPI-00000000-0000-0000-0000-000000000000'};const a=await (await worker.fetch(req('/api/stats','POST'),env)).json();assert.equal(a.queues.solo[0].lp,230);assert.equal(a.queues.flex[0].tier,'UNRANKED');assert.equal(calls,4);
await worker.fetch(req('/api/stats','POST'),env);assert.equal(calls,4);const history=await(await worker.fetch(req('/api/history'),env)).json();assert.equal(history.snapshots.length,1);assert.ok(!JSON.stringify(history).includes(env.RIOT_API_KEY));console.log('Passed: browser script syntax, missing key, both players and queues, shared history, cache, secret exclusion.');

// Matchup denominators must exclude teammates and remakes, and respect queues.
let matchCalls=0;
const participant=(puuid,teamId,win,extra={})=>({puuid,teamId,win,championName:'Ahri',championId:103,kills:4,deaths:2,assists:8,totalMinionsKilled:160,neutralMinionsKilled:20,champExperience:15000,...extra});
const details={
 A:{queueId:420,participants:[participant('p0',100,true),participant('p1',200,false)]},
 B:{queueId:420,participants:[participant('p0',100,false),participant('p1',200,true)]},
 C:{queueId:420,participants:[participant('p0',100,true),participant('p1',100,true)]},
 D:{queueId:420,participants:[participant('p0',100,false,{gameEndedInEarlySurrender:true}),participant('p1',200,true)]},
 E:{queueId:440,participants:[participant('p0',100,true),participant('p1',200,false)]}
};
globalThis.fetch=async(url)=>{matchCalls++;if(url.includes('by-riot-id'))return Response.json({puuid:url.includes('Respectful')?'p0':'p1'});if(url.includes('/ids?'))return Response.json(Object.keys(details));const id=url.split('/').at(-1);return Response.json({info:{gameStartTimestamp:Date.now()-1200000,gameEndTimestamp:Date.now(),...details[id]}});};
const h=await(await worker.fetch(req('/api/matchups','POST'),env)).json();assert.equal(h.records.length,5);assert.equal(h.records.filter(r=>r.kind==='opponents'&&r.queue==='solo').length,2);assert.equal(h.records.filter(r=>r.kind==='teammates').length,1);assert.equal(h.records.filter(r=>r.kind==='remake').length,1);assert.deepEqual(h.records.filter(r=>r.kind==='opponents'&&r.queue==='solo').map(r=>r.winner),[0,1]);assert.equal(h.pending,0);assert.deepEqual(h.counts,[5,5]);assert.ok(h.exhausted.every(Boolean));
const before=matchCalls;const again=await(await worker.fetch(req('/api/matchups','POST'),env)).json();assert.equal(matchCalls,before);assert.equal(again.records.length,5);assert.ok(!JSON.stringify(h).includes(env.RIOT_API_KEY));assert.ok(!JSON.stringify(h).includes('puuid'));
assert.equal(h.records[0].stats[0].cs,180);assert.equal(h.records[0].stats[0].xp,15000);
const migrationKey='matchups-'+new Date().getUTCFullYear()+'.json';const legacy=JSON.parse(store.get(migrationKey));delete legacy.records[0].stats;delete legacy.records[0].statsVersion;store.set(migrationKey,JSON.stringify(legacy));
const migrated=await(await worker.fetch(req('/api/matchups','POST'),env)).json();assert.equal(matchCalls,before+1);assert.equal(migrated.records.length,5);assert.equal(migrated.records[0].stats[0].cs,180);assert.equal(new Set(JSON.parse(store.get(migrationKey)).processed).size,5);
const crossOrigin=new Request('https://test.example/api/matchups',{method:'POST',headers:{Origin:'https://other.example'}});assert.equal((await worker.fetch(crossOrigin,env)).status,403);
// Persist backoff and keep completed results if Riot throttles a wider scan.
globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'Retry-After':'60'}});
const stateKey='matchups-'+new Date().getUTCFullYear()+'.json';const saved=JSON.parse(store.get(stateKey));saved.exhausted=[false,false];store.set(stateKey,JSON.stringify(saved));
const throttled=await(await worker.fetch(req('/api/matchups?older=1','POST'),env)).json();assert.ok(Date.parse(throttled.retryAt)>Date.now()+50000);assert.equal(throttled.records.length,5);
console.log('Passed: opposing-team results, teammates/remakes excluded, queue separation, deduplication, shared cache, origin protection, Retry-After, secret exclusion.');

// Render the actual client with irregular timestamps and LP totals.
const body=html.split('<script>')[0];
assert.ok(body.includes('<title>Schizo Battle</title>'));
for(const text of ['Ranked Flex','Ladder lead','Win rate gap','Snapshots recorded','Every win counts','RIFT RIVALS','LP change since tracking','Ladder points','Riot API �'])assert.ok(!body.includes(text),'Removed UI: '+text);
const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,hidden:false});return elements.get(id);};
const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},fetch:()=>new Promise(()=>{}),setInterval:()=>{},setTimeout:()=>{},console});
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
vm.runInContext('days=1',context);
const at=Date.now()-3600000;const make=(offset,lp)=>({at:new Date(at+offset*60000).toISOString(),source:'Riot API',players:[{tier:'GRANDMASTER',rank:'I',lp,wins:40,losses:20},{tier:'GRANDMASTER',rank:'I',lp:1663,wins:30,losses:20}]});
vm.runInContext('data='+JSON.stringify({solo:[make(0,1301)]})+';draw()',context);assert.ok(element('chart').innerHTML.includes('1,301 LP'));assert.ok(element('chart').innerHTML.includes('1,663 LP'));assert.ok(!element('chart').innerHTML.includes('<path'));assert.ok(element('chart-note').innerHTML.includes('First reading'));
vm.runInContext('data='+JSON.stringify({solo:[make(0,1301),make(1,1325),make(10,1290)]})+';draw()',context);const chart=element('chart').innerHTML;assert.ok(chart.includes('cx="138"'));assert.ok(chart.includes('cx="795"'));assert.ok(chart.includes('1,325 LP'));assert.equal((chart.match(/data-player=/g)||[]).length,2);assert.ok(chart.includes('1,663 LP'));assert.ok(!chart.includes('4,463'));assert.ok(!chart.includes('+0'));
vm.runInContext('data='+JSON.stringify({solo:[make(0,1301),make(10,1301)]})+';draw()',context);const flat=element('chart').innerHTML;const paths=[...flat.matchAll(/<path[^>]+d="([^"]+)"/g)].map(m=>m[1]);assert.equal(paths.length,2);assert.notEqual(paths[0],paths[1],'Two unchanged LP totals must remain on separate lines.');
vm.runInContext('matchupData='+JSON.stringify(h)+';renderMatchups()',context);assert.ok(element('h2h').innerHTML.includes('50.0%'));assert.ok(element('h2h').innerHTML.includes('2 direct matchups'));assert.ok(element('h2h').innerHTML.includes('Opposing teams only'));assert.ok(!element('h2h').innerHTML.includes('<details'));assert.ok(element('scanOlder').hidden);
console.log('Passed: Solo/Duo-only interface, new name, removed clutter, actual LP totals, two distinct player lines, time spacing, and head-to-head rendering.');

// Unequal match lengths and deaths distinguish means from pooled ratios.
const championRows=[{queue:'solo',kind:'opponents',winner:0,champions:['Ahri','Rengar'],duration:1200,stats:[{championId:103,kills:10,deaths:0,assists:2,cs:200,xp:10000},{championId:107,kills:2,deaths:5,assists:3,cs:100,xp:8000}]},{queue:'solo',kind:'opponents',winner:1,champions:['Ahri','Elise'],duration:2400,stats:[{championId:103,kills:2,deaths:4,assists:6,cs:240,xp:20000},{championId:60,kills:8,deaths:0,assists:4,cs:160,xp:18000}]}];
vm.runInContext('testRows='+JSON.stringify(championRows),context);
const summary=vm.runInContext('summarizeChampion(testRows,0)',context);assert.equal(summary.cs,220);assert.equal(summary.csm,8);assert.equal(summary.xp,15000);assert.equal(summary.kda,5);assert.equal(summary.wins,1);
vm.runInContext('renderChampions(testRows)',context);assert.ok(element('champion-stats').innerHTML.includes('5.00 KDA'));assert.ok(element('champion-stats').innerHTML.includes('Perfect'));assert.ok(!element('champion-stats').innerHTML.includes('15,000'));assert.ok(element('champion-stats').innerHTML.includes('champion-icons/103.png'));
assert.ok(element('champion-stats').innerHTML.includes('Rengar'));assert.ok(element('champion-stats').innerHTML.includes('Elise'));
for(const text of ['24 hours','View matches','All champions','Most games','Avg CS','CS / min','Avg XP','Full-match averages','champion-note','championSort'])assert.ok(!html.includes(text),'Removed clutter: '+text);
assert.ok(!element('champion-stats').innerHTML.includes('Overall in selected matchups'));
vm.runInContext('renderChampions([])',context);assert.ok(element('champion-stats').innerHTML.includes('No head-to-head games yet.'));
const missing=vm.runInContext("summarizeChampion([{duration:1200,winner:0,kda:['4/0/8','0/4/0']}],0)",context);assert.equal(missing.cs,null);assert.equal(missing.xp,null);assert.equal(missing.kda,Infinity);assert.equal(missing.csGames,0);
console.log('Passed: CS includes jungle, XP extraction, legacy backfill without duplicates, champion averages, zero deaths, missing data, compact champion lists, removed controls, and empty states.');

vm.runInContext('days=30;data={solo:[]};draw()',context);const older=element('chart').innerHTML;assert.ok(older.includes('622 LP'));assert.ok(older.includes('1,718 LP'));assert.ok(older.includes('2026-11-05'));assert.ok(older.includes('OP.GG'));assert.equal((older.match(/data-player=/g)||[]).length,2);assert.ok(element('chart-note').innerHTML.includes('OP.GG'));const historicPath=older.match(/data-player="0" d="([^"]+)"/)[1];assert.equal((historicPath.match(/M/g)||[]).length,1,'Different player observation dates must not disconnect the line.');console.log('Passed: verified historical observations, independent player dates, continuous per-player lines, date-only source attribution.');

