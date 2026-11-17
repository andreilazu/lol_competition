import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker/index.js';

// In-memory bucket and a fake Riot API: two players, 'game' controls who is in which match.
const values=new Map();
const BUCKET={async get(k){return values.has(k)?{json:async()=>JSON.parse(values.get(k))}:null;},async put(k,v){values.set(k,v);},async list(){return {objects:[]};}};
const env={RIOT_API_KEY:'RGAPI-'+'0'.repeat(36),BUCKET};
let games={},calls=[];
const player=(puuid,teamId,championId)=>({puuid,teamId,championId,riotId:puuid+'#EUNE',spell1Id:4,spell2Id:11,bot:false});
const match=(gameId,parts)=>({gameId,gameQueueConfigId:420,gameMode:'CLASSIC',mapId:11,gameStartTime:Date.now()-600000,gameLength:600,participants:parts,bannedChampions:[{championId:157,teamId:100},{championId:-1,teamId:200}]});
globalThis.fetch=async url=>{
 const u=new URL(url);calls.push(u.pathname);
 if(u.pathname.includes('/accounts/by-riot-id/'))return Response.json({puuid:u.pathname.includes('Respectful')?'p0':'p1'});
 if(u.pathname.includes('/active-games/by-summoner/')){const id=u.pathname.split('/').pop();return games[id]?Response.json(games[id]):new Response('{}',{status:404});}
 if(u.pathname.includes('/entries/by-puuid/'))return Response.json(u.pathname.endsWith('/x9')?[]:[{queueType:'RANKED_SOLO_5x5',tier:'GRANDMASTER',rank:'I',leaguePoints:1300,wins:10,losses:5}]);
 throw Error('Unexpected '+url);
};
const call=async()=>{if(values.has('live.json'))values.set('live.json',JSON.stringify({...JSON.parse(values.get('live.json')),at:'2000-01-01T00:00:00Z'}));const r=await worker.fetch(new Request('https://t.example/api/live'),env);assert.equal(r.status,200);return r.json();};

// Neither playing.
let d=await call();assert.deepEqual(d.games,[]);

// Same game: one entry with both tracked, puuids never exposed.
const duo=match(1,[player('p0',100,412),player('p1',100,120),player('x2',200,1),player('x9',200,2)]);
games={p0:duo,p1:duo};d=await call();
assert.equal(d.games.length,1);assert.deepEqual(d.games[0].tracked,[0,1]);
assert.equal(d.games[0].participants.find(p=>p.championId===412).tracked,0);
assert.equal(d.games[0].participants.find(p=>p.championId===2).rank.tier,'UNRANKED');
assert.equal(d.games[0].bans.length,1);assert.ok(!JSON.stringify(d).includes('"puuid"'));assert.ok(!JSON.stringify(d).includes('p0"'));

// Ranks are fetched once per game and reused.
const before=calls.filter(p=>p.includes('/entries/')).length;await call();
assert.equal(calls.filter(p=>p.includes('/entries/')).length,before);

// Separate games: two entries. Only one playing: one entry.
games={p0:match(1,[player('p0',100,412)]),p1:match(2,[player('p1',200,120)])};d=await call();
assert.deepEqual(d.games.map(g=>g.tracked),[[0],[1]]);
games={p1:match(2,[player('p1',200,120)])};d=await call();assert.deepEqual(d.games.map(g=>g.tracked),[[1]]);

// Short cache: a second request within the TTL does not hit Riot.
const n=calls.length;await worker.fetch(new Request('https://t.example/api/live'),env);assert.equal(calls.length,n);

// Riot failure falls back to the last result.
globalThis.fetch=async()=>new Response('{}',{status:500});values.set('live.json',JSON.stringify({at:'2000-01-01T00:00:00Z',games:d.games,ranks:{}}));
const stale=await(await worker.fetch(new Request('https://t.example/api/live'),env)).json();assert.equal(stale.stale,true);assert.equal(stale.games.length,1);

// Page renders one card per game, a shared title for duos and the idle state.
const page=await(await worker.fetch(new Request('https://t.example/live/'),{})).text();
assert.ok(page.includes('href="/live/" aria-current="page"'));
const els=new Map();const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',disabled:false,setAttribute(){}});return els.get(id);};
const ctx=vm.createContext({document:{getElementById:el,querySelector:()=>null,addEventListener(){},hidden:false},fetch:()=>new Promise(()=>{}),setTimeout:()=>0,clearTimeout(){},setInterval(){}});
vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);
const show=data=>{vm.runInContext('live='+JSON.stringify(data)+';fetchedAt=Date.now();render()',ctx);return el('live-feed').innerHTML;};
let html=show({at:new Date().toISOString(),games:[sample(duo)]});
function sample(g){return {gameId:1,queueId:420,startedAt:new Date(Date.now()-65000).toISOString(),gameLength:65,tracked:[0,1],participants:g.participants.map(p=>({teamId:p.teamId,championId:p.championId,riotId:p.riotId,spells:[4,11],tracked:p.puuid==='p0'?0:p.puuid==='p1'?1:null,rank:{tier:'DIAMOND',rank:'II',lp:45,wins:3,losses:1}})),bans:[]};}
assert.equal((html.match(/<article/g)||[]).length,1);assert.ok(html.includes('playing together'));assert.ok(html.includes('Ranked Solo/Duo'));assert.ok(html.includes('D2 45 LP'));assert.ok(html.includes('1:05'));
assert.ok(el('status-row').innerHTML.split('In game').length===3);
html=show({at:new Date().toISOString(),games:[]});assert.ok(html.includes('Nobody is in game'));assert.ok(!el('status-row').innerHTML.includes('In game'));
console.log('Passed: live games merge duos, split separate games, show a single player, cache ranks and results, fall back when Riot fails, and render the page states.');
