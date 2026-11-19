import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker,{newsThreadId} from '../worker/index.js';

// In-memory store with the same get/put/list shape as the Netlify adapter.
const values=new Map();
const BUCKET={async get(k){return values.has(k)?{json:async()=>JSON.parse(values.get(k))}:null;},async put(k,v){values.set(k,v);},async list({prefix='',limit=1000}={}){return {objects:[...values.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(key=>({key}))};}};
const env={BUCKET};
let ip=1;const nextIp=()=>'10.0.0.'+(ip++);
const call=(path,body,o={})=>worker.fetch(new Request('https://t.example'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','x-nf-client-connection-ip':o.ip||nextIp(),...(o.origin?{Origin:o.origin}:{})},body:typeof body==='string'?body:JSON.stringify(body)}),o.env||env);
const get=async path=>{const r=await call(path);return {status:r.status,body:await r.json()};};
const post=async(path,body,o)=>{const r=await call(path,body,o);return {status:r.status,body:await r.json()};};

// Empty forum.
let r=await get('/api/forum');assert.equal(r.status,200);assert.deepEqual(r.body.threads,[]);assert.ok(r.body.categories.general);

// New thread, then replies from others.
r=await post('/api/forum/thread',{name:'  Viewer  ',title:'Who  reaches Challenger first?',cat:'general',body:'My bet is on\r\n\r\n\r\n\r\n\r\nregelepetras2006.'});
assert.equal(r.status,201);const t=r.body.thread;assert.equal(t.title,'Who reaches Challenger first?','Whitespace in titles collapses.');assert.equal(t.author,'Viewer');assert.equal(t.posts,1);
await post('/api/forum/post',{threadId:t.id,name:'Bob',body:'<script>alert(1)</script> no way'});
await post('/api/forum/post',{threadId:t.id,name:'Ann',body:'Respectful Jew obviously'});
r=await get('/api/forum/thread?id='+t.id);assert.equal(r.status,200);
assert.deepEqual(r.body.posts.map(p=>p.name),['Viewer','Bob','Ann'],'Posts are in order.');
assert.equal(r.body.posts[0].body,'My bet is on\n\n\nregelepetras2006.','Line endings normalised, long blank runs trimmed.');
assert.equal(r.body.thread.posts,3);assert.equal(r.body.thread.lastBy,'Ann');
r=await get('/api/forum');assert.equal(r.body.threads[0].posts,3);

// Validation.
assert.equal((await post('/api/forum/thread',{name:'A',title:'Valid title',cat:'general',body:'hi'})).status,400,'Nickname too short.');
assert.equal((await post('/api/forum/thread',{name:'Abc',title:'no',cat:'general',body:'hi'})).status,400,'Title too short.');
assert.equal((await post('/api/forum/thread',{name:'Abc',title:'Valid title',cat:'nope',body:'hi'})).status,400,'Unknown category.');
assert.equal((await post('/api/forum/thread',{name:'Abc',title:'Valid title',cat:'__proto__',body:'hi'})).status,400,'Prototype keys are not categories.');
assert.equal((await post('/api/forum/post',{threadId:t.id,name:'Abc',body:'x'.repeat(2001)})).status,400,'Message too long.');
assert.equal((await post('/api/forum/post',{threadId:t.id,name:'Abc',body:'   '})).status,400,'Empty message.');
assert.equal((await post('/api/forum/post',{threadId:'missing1',name:'Abc',body:'hi'})).status,404);
assert.equal((await post('/api/forum/post',{threadId:'../index',name:'Abc',body:'hi'})).status,404,'Thread ids cannot reach other keys.');
assert.equal((await post('/api/forum/post','{not json')).status,400);
assert.equal((await post('/api/forum/post','x'.repeat(13000))).status,413);
assert.equal((await post('/api/forum/post',{threadId:t.id,name:'Abc',body:'hi'},{origin:'https://evil.example'})).status,403);
assert.equal((await call('/api/forum/thread?id=nothere1')).status,404);
assert.equal((await worker.fetch(new Request('https://t.example/api/forum'),{})).status,503);
assert.equal((await worker.fetch(new Request('https://t.example/api/forum',{method:'DELETE'}),env)).status,405);

// Spam trap: quiet success, nothing stored.
const before=values.size;r=await post('/api/forum/post',{threadId:t.id,name:'Bot',body:'buy now',website:'http://spam.example'});
assert.equal(r.status,200);assert.equal(values.size,before,'Bots filling the hidden field store nothing.');

// Rate limits, per visitor.
const me='10.9.9.9';
assert.equal((await post('/api/forum/post',{threadId:t.id,name:'Fast',body:'one'},{ip:me})).status,201);
r=await post('/api/forum/post',{threadId:t.id,name:'Fast',body:'two'},{ip:me});assert.equal(r.status,429);assert.match(r.body.error,/wait \d+ seconds/);
assert.equal((await post('/api/forum/post',{threadId:t.id,name:'Other',body:'fine'},{ip:'10.9.9.8'})).status,201,'Other visitors are not affected.');
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
try{
 const spam='10.7.7.7';let codes=[];
 for(let i=0;i<7;i++){codes.push((await post('/api/forum/post',{threadId:t.id,name:'Busy',body:'msg '+i},{ip:spam})).status);clock+=11000;}
 assert.deepEqual(codes,[201,201,201,201,201,201,429],'Six posts per ten minutes.');
 const maker='10.6.6.6';codes=[];
 for(let i=0;i<9;i++){codes.push((await post('/api/forum/thread',{name:'Maker',title:'Thread number '+i,cat:'offtopic',body:'x'},{ip:maker})).status);clock+=700000;}
 assert.deepEqual(codes,[...Array(8).fill(201),429],'Eight new threads per day.');
}finally{Date.now=realNow;}
assert.ok(![...values.keys()].some(k=>k.includes('10.')),'IPs are never stored, only salted hashes.');
assert.ok(![...values.values()].some(v=>v.includes('10.7.7.7')));

// News threads: one per story, created by the first comment, reused after.
const story='lp:overtake:2026-11-19T15:50:58.119Z:0';
r=await get('/api/forum/thread?news='+encodeURIComponent(story));assert.equal(r.status,200);assert.equal(r.body.thread,null);
r=await post('/api/forum/thread',{newsId:story,title:'Respectful Jew passes regelepetras2006 in the LP race',name:'Fan',body:'Finally!'});assert.equal(r.status,201);
assert.equal(r.body.thread.id,newsThreadId(story));assert.equal(r.body.thread.cat,'news');assert.equal(r.body.thread.newsId,story);
r=await post('/api/forum/thread',{newsId:story,title:'Different title',name:'Fan2',body:'Agreed'});assert.equal(r.status,201);
r=await get('/api/forum/thread?news='+encodeURIComponent(story));assert.equal(r.body.posts.length,2);assert.equal(r.body.thread.title,'Respectful Jew passes regelepetras2006 in the LP race','A later comment cannot rename the thread.');
r=await get('/api/forum');assert.equal(r.body.threads.filter(x=>x.newsId===story).length,1);

// A lost index update is repaired when the thread is opened.
const idx=JSON.parse(values.get('forum/index.json'));idx.threads[t.id].posts=1;values.set('forum/index.json',JSON.stringify(idx));
const real=(await get('/api/forum/thread?id='+t.id)).body.posts.length;
assert.equal((await get('/api/forum')).body.threads.find(x=>x.id===t.id).posts,real);
console.log('Passed: forum threads and replies, validation, spam trap, per-visitor rate limits, hashed IPs, news threads, and index repair.');

// Pages: nav link everywhere, forum page renders lists and threads with everything escaped.
for(const path of ['/','/news/','/live/','/whos-fault/'])assert.ok((await(await worker.fetch(new Request('https://t.example'+path),{})).text()).includes('<a href="/forum/">Forum</a>'),'Forum link on '+path);
const page=await(await worker.fetch(new Request('https://t.example/forum/'),{})).text();
assert.ok(page.includes('<title>Forum · Schizo Battle</title>'));assert.ok(page.includes('href="/forum/" aria-current="page"'));
const run=async(search)=>{
 const els=new Map();const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,setAttribute(){},focus(){}});return els.get(id);};
 const fetchLocal=async(url,init)=>worker.fetch(new Request('https://t.example'+url,init),env);
 const ctx=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>null,title:''},location:{search,href:''},localStorage:{getItem:()=>null,setItem(){}},fetch:fetchLocal,setInterval(){},URLSearchParams,Intl,console,encodeURIComponent});
 vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);await new Promise(r=>setTimeout(r,50));return el;
};
let el=await run('');
assert.ok(el('view').innerHTML.includes('thread-row'));assert.ok(el('view').innerHTML.includes('Who reaches Challenger first?'));assert.ok(el('activity').innerHTML.includes('act-row'));
assert.ok(el('view').innerHTML.includes('Start a new thread'));assert.ok(!el('view').innerHTML.includes('<option value="news"'),'News threads only come from stories.');
el=await run('?t='+t.id);
assert.ok(el('view').innerHTML.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!el('view').innerHTML.includes('<script>alert'),'Posts are escaped.');
assert.ok(el('view').innerHTML.includes('<span class="who-a">Respectful Jew</span>'),'Player names are coloured in message text.');
assert.ok(el('view').innerHTML.includes('<b>Viewer</b>'));
el=await run('?news='+encodeURIComponent('lp:none')+'&title='+encodeURIComponent('A <b>story</b>'));
assert.ok(el('view').innerHTML.includes('No comments yet'));assert.ok(el('view').innerHTML.includes('A &lt;b&gt;story&lt;/b&gt;'));assert.ok(el('view').innerHTML.includes('Back to news'));
el=await run('?t=zzzzzzzz');assert.ok(el('view').innerHTML.includes('Thread not found'));
console.log('Passed: forum nav links, list and thread rendering, escaping, news comment view, and missing threads.');
