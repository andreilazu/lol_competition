import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
