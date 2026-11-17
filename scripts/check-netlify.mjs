import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from '../worker/index.js';
import handler,{config} from '../netlify/functions/api.mjs';
import {createBucket} from '../netlify/lib/bucket.mjs';
import seed from '../netlify/lib/bootstrap.mjs';

const values=new Map();
const store={
 async get(key,options){assert.equal(options.type,'text');return values.get(key)??null;},
 async set(key,value){values.set(key,value);},
 async *list({prefix,paginate}){
  assert.equal(paginate,true);
  for(const key of values.keys())if(key.startsWith(prefix))yield {blobs:[{key}]};
 }
};
const BUCKET=createBucket(store,seed);
assert.equal(typeof handler,'function');assert.equal(config.path,'/api/*');
assert.equal(await BUCKET.get('missing'),null);
await BUCKET.put('check.json',JSON.stringify({ok:true}));
assert.deepEqual(await(await BUCKET.get('check.json')).json(),{ok:true});
const history=await(await worker.fetch(new Request('https://netlify.example/api/history'),{BUCKET})).json();
assert.ok(history.snapshots.length>0);
const old=history.snapshots[0];const key='snapshots/'+String(9999999999999-Date.parse(old.at))+'.json';
await BUCKET.put(key,JSON.stringify({...old,source:'updated'}));
assert.equal((await(await BUCKET.get(key)).json()).source,'updated');
assert.equal((await BUCKET.list({prefix:'snapshots/'})).objects.length,history.snapshots.length,'Seed and stored snapshots must deduplicate.');
await BUCKET.put('snapshots/0000000000000.json',JSON.stringify(old));
assert.equal((await BUCKET.list({prefix:'snapshots/',limit:1})).objects[0].key,'snapshots/0000000000000.json');
const matches=await(await worker.fetch(new Request('https://netlify.example/api/matchups'),{BUCKET})).json();
assert.ok(matches.records.length>0);
const html=await readFile('public/index.html','utf8');assert.ok(html.includes('Champions head-to-head'));
for(const removed of ['24 hours','View matches','All champions','Avg CS'])assert.ok(!html.includes(removed));
assert.ok(!html.includes('RGAPI-'));assert.ok(!JSON.stringify(seed).includes('puuid'));
console.log('Passed: Netlify function import and routing, persistent storage adapter, preserved history, pagination, seed overrides, deduplication, and static page.');

const fault=await readFile('public/whos-fault/index.html','utf8');
for(const path of ['/whos-fault','/whos-fault/'])assert.equal((await worker.fetch(new Request('https://test.example'+path),{})).status,200);
assert.ok(html.includes('href="/whos-fault/"'));assert.ok(fault.includes('Just for fun'));assert.ok(!fault.includes('Find the culprit'));assert.ok(!fault.includes('KDA in losses'));
const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,setAttribute(){},querySelector(){return null;}});return elements.get(id);};
const saved=new Map();const localStorage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)};
const context=vm.createContext({document:{getElementById:element},fetch:()=>new Promise(()=>{}),setTimeout:()=>{},localStorage});
vm.runInContext(fault.match(/<script>([\s\S]*?)<\/script>/)[1],context);
const selections=vm.runInContext('Array.from({length:300},(_,i)=>chooseBlame(()=>i/300))',context);
assert.equal(selections.filter(i=>i===0).length,100);assert.equal(selections.filter(i=>i===1).length,200);
assert.equal(vm.runInContext('chooseBlame(()=>1/3)',context),1);
const first=vm.runInContext("matchVerdict({id:'respectful',duration:1800},()=>0)",context);assert.equal(first.culprit,0);assert.equal(first.reason,'Missed Q.');
const second=vm.runInContext("matchVerdict({id:'regele',duration:1800},(()=>{const values=[0.5,0];return ()=>values.shift();})())",context);assert.equal(second.culprit,1);assert.equal(second.reason,'Lost tempo doing nothing.');
const focused=vm.runInContext("matchVerdict({id:'focus',duration:600},()=>0.5)",context);assert.equal(focused.reason,'Lost focus at 9:00.');
const repeated=vm.runInContext("matchVerdict({id:'respectful'},()=>{throw Error('Should not reroll');})",context);assert.equal(repeated.reason,first.reason);
vm.runInContext('verdicts.clear()',context);assert.equal(vm.runInContext("matchVerdict({id:'respectful'},()=>{throw Error('Storage should retain verdict');}).reason",context),first.reason);
const loss={id:'older',at:'2026-11-15T12:00:00Z',duration:1800,queue:'solo',kind:'teammates',teamWon:false,champions:['Thresh','Hecarim'],kda:['4/3/2','1/5/4'],stats:[{championId:412,kills:4,deaths:3,assists:2},{championId:120,kills:1,deaths:5,assists:4}]};
const won={...loss,id:'win',teamWon:true,kda:['100/0/100','100/0/100']};
const rows=[loss,{...loss,id:'newest',at:'2026-11-16T12:00:00Z'},won,{...loss,kind:'opponents'},{...loss,kind:'remake'},{...loss,queue:'flex'}];
vm.runInContext('renderDuo('+JSON.stringify({records:rows})+')',context);
assert.equal(element('loss-count').textContent,'2 shared losses');
const cards=element('loss-feed').innerHTML;assert.equal((cards.match(/<article/g)||[]).length,2);assert.ok(cards.includes('champion-icons/412.png'));assert.ok(cards.includes('champion-icons/120.png'));assert.ok(cards.includes('2.00 KDA'));assert.ok(cards.includes('1.00 KDA'));assert.ok(cards.includes('<span class="deaths">3</span>'));assert.ok(cards.includes('match-verdict'));assert.ok(cards.indexOf('2026-11-16')<cards.indexOf('2026-11-15'));
vm.runInContext('renderDuo({records:[]})',context);assert.ok(element('loss-feed').innerHTML.includes('No shared losses found.'));
vm.runInContext('renderDuo('+JSON.stringify({records:[{...loss,teamWon:undefined}]})+')',context);assert.equal(element('feed-status').textContent,'Checking duo games…');
console.log('Passed: per-match loss cards, champion portraits, individual KDA, newest first, weighted reasons, in-game timestamps, verdict persistence, outcome filters, and empty states.');
