import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker/index.js';

const year=new Date().getUTCFullYear();
const legacy={verificationVersion:1,season:year,ids:[['BASE'],['BASE']],offset:[1,1],exhausted:[true,true],processed:['BASE'],pending:[],records:[{id:'BASE',queue:'solo',kind:'opponents',winner:0,at:year+'-03-01T00:00:00Z',duration:1200,champions:['Ahri','Rengar'],kda:['4/2/8','2/4/3'],statsVersion:1}],checkedAt:new Date().toISOString()};
const data=new Map([['matchups-'+year+'.json',JSON.stringify(legacy)],['accounts.json',JSON.stringify([{puuid:'p0'},{puuid:'p1'}])]]);
const BUCKET={async get(key){return data.has(key)?{json:async()=>JSON.parse(data.get(key))}:null;},async put(key,value){data.set(key,value);}};
const env={BUCKET,RIOT_API_KEY:'test'};
const call=async(method='POST')=>(await worker.fetch(new Request('https://test.example/api/matchups?older=1',{method}),env)).json();
let throttle=true;const requests=[];
globalThis.fetch=async url=>{
 const u=new URL(url);requests.push(u);
 if(u.pathname.endsWith('/ids')){
  assert.equal(u.searchParams.has('startTime'),false,'Older matches must not be limited to January 1.');
  assert.ok(Number(u.searchParams.get('endTime'))>0);
  const player=u.pathname.includes('/p0/')?0:1,start=Number(u.searchParams.get('start'));
  if(start===0)return Response.json(Array.from({length:100},(_,i)=>player+'_'+i));
  assert.equal(start,100,'Saved cursors must resume after the previous page.');
  if(player===1&&throttle){throttle=false;return new Response('{}',{status:429,headers:{'Retry-After':'60'}});}
  return Response.json(['OLD','GONE']);
 }
 if(u.pathname.endsWith('/GONE'))return new Response('{}',{status:404});
 assert.ok(u.pathname.endsWith('/OLD'));
 return Response.json({info:{queueId:420,gameStartTimestamp:Date.UTC(year-1,6,1),gameDuration:1800,participants:[{puuid:'p0',teamId:100,win:false,championName:'Ahri',kills:1,deaths:2,assists:3},{puuid:'p1',teamId:200,win:true,championName:'Rengar',kills:2,deaths:1,assists:4}]}});
};
const migrated=await call('GET');assert.deepEqual(migrated.exhausted,[false,false]);assert.equal(migrated.records.length,1);
const first=await call();assert.deepEqual(first.counts,[101,101]);assert.equal(first.records.length,1,'A scanned page can correctly find no new shared games.');
const limited=await call();assert.equal(limited.rateLimited,true);assert.ok(limited.retryAt);assert.equal(limited.records.length,1);
const state=JSON.parse(data.get('matchups-all.json'));assert.equal(state.offset[0],102);state.retryAt=new Date(0).toISOString();data.set('matchups-all.json',JSON.stringify(state));
const complete=await call();assert.deepEqual(complete.exhausted,[true,true]);assert.equal(complete.records.length,2);assert.equal(complete.records.find(r=>r.id==='OLD').at,(year-1)+'-07-01T00:00:00.000Z');assert.equal(complete.unavailable,1);assert.equal(complete.pending,0);
assert.equal(requests.filter(u=>u.pathname.endsWith('/OLD')).length,1);
const callsBefore=requests.length;await call();assert.equal(requests.length,callsBefore,'Exhausted history must not be rescanned.');

const html=await(await worker.fetch(new Request('https://test.example/'),{})).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements=new Map(),timers=[];const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,hidden:false});return elements.get(id);};
const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},fetch:()=>new Promise(()=>{}),setInterval:()=>{},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{},console});
vm.runInContext(script,context);
const response=d=>async()=>Response.json(d);
context.fetch=response({...first,historyScope:'available'});
await vm.runInContext('matchupBusy=false;olderScanning=true;loadMatchups(true)',context);
assert.equal(timers.length,1,'Continue automatically when a page has no shared matches.');assert.equal(element('scanOlder').textContent,'Searching…');assert.equal(element('scanOlder').disabled,true);
context.fetch=response(limited);await timers.shift().fn();assert.ok(timers[0].ms>50000,'Respect persisted Retry-After.');
context.fetch=response(complete);await timers.shift().fn();assert.equal(timers.length,0);assert.equal(element('scanOlder').hidden,true);assert.ok(element('h2h').innerHTML.includes('End of available history'));
context.fetch=async()=>{throw Error('Network unavailable');};await vm.runInContext('olderScanning=true;loadMatchups(true)',context);assert.ok(element('h2h').innerHTML.includes('Network unavailable'));assert.equal(element('scanOlder').textContent,'Retry search');
console.log('Passed: season migration, pre-season matches, multi-page scans without shared games, persisted cursors, throttling resume, missing match skipping, automatic client continuation, progress, and visible errors.');

// Re-resolve Riot IDs and re-fetch existing matches rather than trusting imports.
const stale={...legacy,records:[{...legacy.records[0],id:'OLD'}, {...legacy.records[0],id:'WRONG'}],ids:[['OLD','WRONG'],['OLD','WRONG']],processed:['OLD','WRONG'],historyScope:'available'};
delete stale.verificationVersion;
data.set('matchups-all.json',JSON.stringify(stale));
data.set('accounts.json',JSON.stringify([{puuid:'outdated0'},{puuid:'outdated1'}]));
let resolved=0;
globalThis.fetch=async url=>{
 if(url.includes('/by-riot-id/')){resolved++;return Response.json({puuid:url.includes('Respectful')?'p0':'p1'});}
 if(url.includes('/ids?'))return Response.json(['OLD','NEW']);
 const id=url.split('/').at(-1);
 return Response.json({info:{queueId:420,gameVersion:'26.22',gameStartTimestamp:Date.UTC(year,10,16),gameDuration:1800,participants:[{puuid:'p0',teamId:100,win:true,championName:'Ahri',kills:5,deaths:2,assists:4}, {puuid:id==='WRONG'?'unrelated':'p1',teamId:200,win:false,championName:'Rengar',kills:2,deaths:5,assists:1}]}});
};
const fresh=await(await worker.fetch(new Request('https://test.example/api/matchups?refresh=1',{method:'POST'}),env)).json();
assert.equal(resolved,2,'Cached identities must not prevent fresh account lookups.');
assert.deepEqual(fresh.records.map(r=>r.id).sort(),['NEW','OLD']);
assert.equal(fresh.records.find(r=>r.id==='OLD').at,year+'-11-16T00:00:00.000Z');
assert.ok(fresh.records.every(r=>r.verifiedAt&&r.gameVersion==='26.22'));
assert.ok(fresh.accountsCheckedAt);assert.equal(fresh.pending,0);assert.ok(!JSON.stringify(fresh).includes('puuid'));
console.log('Passed: fresh account resolution, cached-date replacement from Riot, new recent matches, removal of unrelated cached records, and verification provenance.');
