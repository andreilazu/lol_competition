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
assert.ok(html.includes('href="/whos-fault/"'));assert.ok(fault.includes('Random verdict'));
const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',style:{setProperty(){}}});return elements.get(id);};
const context=vm.createContext({document:{getElementById:element},fetch:()=>new Promise(()=>{}),setTimeout:()=>{}});
vm.runInContext(fault.match(/<script>([\s\S]*?)<\/script>/)[1],context);
const selections=vm.runInContext('Array.from({length:300},(_,i)=>chooseBlame(()=>i/300))',context);
assert.equal(selections.filter(i=>i===0).length,100);assert.equal(selections.filter(i=>i===1).length,200);
assert.equal(vm.runInContext('chooseBlame(()=>1/3)',context),1);
vm.runInContext('Math.random=()=>0;blame()',context);assert.ok(element('verdict').innerHTML.includes("Respectful Jew's fault."));
vm.runInContext('Math.random=()=>0.5;blame()',context);assert.ok(element('verdict').innerHTML.includes("regelepetras2006's fault."));assert.equal(element('blame').textContent,'Blame again');
const loss={queue:'solo',kind:'teammates',teamWon:false,kda:['4/3/2','1/5/4']};
const won={...loss,teamWon:true,kda:['100/0/100','100/0/100']};
const rows=[loss,loss,won,{...loss,kind:'opponents'},{...loss,kind:'remake'},{...loss,queue:'flex'}];
vm.runInContext('renderDuo('+JSON.stringify({records:rows})+')',context);
assert.equal(element('duo-note').textContent,'3 games together · 2 losses');
assert.ok(element('duo-stats').innerHTML.includes('<strong>2.00</strong>'));assert.ok(element('duo-stats').innerHTML.includes('<strong>3.0</strong>'));assert.ok(element('duo-stats').innerHTML.includes('<strong>5.0</strong>'));
vm.runInContext('renderDuo({records:[]})',context);assert.ok(element('duo-stats').innerHTML.includes('No shared losses found.'));
vm.runInContext('renderDuo('+JSON.stringify({records:[{...loss,teamWon:undefined}]})+')',context);assert.equal(element('duo-note').textContent,'Checking duo games…');
console.log('Passed: blame page routes, exact 1/3 and 2/3 weights, both verdicts, teammate losses only, aggregate KDA, missing outcome handling, and empty state.');
