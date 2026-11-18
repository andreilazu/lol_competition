import assert from 'node:assert/strict';
import worker from '../worker/index.js';

// Riot encrypts player IDs per API key. After a key rotation, cached IDs no longer match anything
// Riot returns. Stored games must survive that, and the server must heal by refetching the IDs.
const year=new Date().getUTCFullYear();
const record=(id,kind='opponents')=>({id,queue:'solo',kind,winner:kind==='opponents'?0:null,teamWon:kind==='teammates'?true:null,at:year+'-03-01T00:00:00Z',duration:1500,champions:['Thresh','Rengar'],kda:['1/2/3','3/2/1'],statsVersion:1,stats:[{kills:1,deaths:2,assists:3},{kills:3,deaths:2,assists:1}]});
const ids=['G1','G2','G3','G4','G5','G6','G7','G8'];
const state={verificationVersion:1,historyScope:'available',season:year,ids:[ids,ids],offset:[100,100],exhausted:[true,true],processed:ids,pending:[],records:ids.map((id,i)=>record(id,i%2?'teammates':'opponents')),checkedAt:new Date().toISOString()};
const data=new Map([['matchups-all.json',JSON.stringify(state)],['accounts.json',JSON.stringify([{puuid:'old0'},{puuid:'old1'}])]]);
const BUCKET={async get(k){return data.has(k)?{json:async()=>JSON.parse(data.get(k))}:null;},async put(k,v){data.set(k,v);}};
const env={BUCKET,RIOT_API_KEY:'RGAPI-new-key-0000000000000000000000'};
let lookups=0,ghost=new Set();
globalThis.fetch=async url=>{
 const u=new URL(url);
 if(u.pathname.includes('/by-riot-id/')){lookups++;return Response.json({puuid:u.pathname.includes('Respectful')?'new0':'new1'});}
 if(u.pathname.includes('/by-puuid/')){if(u.pathname.includes('/old'))return new Response('{"status":{"message":"Exception decrypting"}}',{status:400});return Response.json(ids);}
 const id=u.pathname.split('/').pop(),kind=state.records.find(r=>r.id===id)?.kind;
 const p=(puuid,teamId,win)=>({puuid:ghost.has(id)?'someone-else-'+puuid:puuid,teamId,win,championName:'Thresh',championId:412,kills:2,deaths:1,assists:9,largestKillingSpree:2,riotIdGameName:'X',riotIdTagline:'1'});
 return Response.json({info:{queueId:420,gameStartTimestamp:Date.UTC(year,2,1),gameDuration:1500,participants:[p('new0',100,true),p('new1',kind==='teammates'?100:200,kind==='teammates')]}});
};
const post=async(q='')=>(await worker.fetch(new Request('https://t.example/api/matchups'+q,{method:'POST'}),env)).json();

// Legacy cache (no key tag) with stale IDs: the backfill refetches IDs once and keeps every game.
let d=await post();
assert.equal(d.records.length,8,'A key rotation must never delete stored games.');
assert.equal(lookups,2,'Stale IDs are refetched once, not per game.');
assert.deepEqual(JSON.parse(data.get('accounts.json')).map(a=>a.puuid),['new0','new1']);
assert.ok(data.has('accounts-key.json'));assert.ok(!data.get('accounts-key.json').includes(env.RIOT_API_KEY),'Only a hash of the key is stored.');
while(d.pending)d=await post();
assert.ok(d.records.every(r=>r.statsVersion===2),'Every game is upgraded with the new key.');

// Next rotation with a key tag on file: IDs refetch before any Riot match call, and the 400 never surfaces.
data.set('accounts.json',JSON.stringify([{puuid:'old0'},{puuid:'old1'}]));
env.RIOT_API_KEY='RGAPI-rotated-again-00000000000000000000';
const st=JSON.parse(data.get('matchups-all.json'));st.checkedAt=null;data.set('matchups-all.json',JSON.stringify(st));
lookups=0;d=await post();
assert.equal(d.error,null);assert.equal(lookups,2);assert.equal(d.records.length,8);

// A match that still contains neither player after fresh IDs is kept, flagged, and not re-read forever.
const st2=JSON.parse(data.get('matchups-all.json'));st2.records.find(r=>r.id==='G3').statsVersion=1;data.set('matchups-all.json',JSON.stringify(st2));
ghost=new Set(['G3']);d=await post();
assert.equal(d.records.length,8);assert.equal(d.pending,0,'An unmatched game does not loop in the backfill.');
const news=await(await worker.fetch(new Request('https://t.example/api/news'),env)).json();assert.equal(news.pending,0);
assert.ok(!JSON.stringify(d).includes('puuid'));
console.log('Passed: key rotation keeps every stored game, refetches player IDs once, stores only a key hash, heals decrypt errors, and never loops on unmatched games.');
