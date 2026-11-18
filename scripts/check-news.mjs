import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker,{buildNews} from '../worker/index.js';

// Synthetic shared games: 'stat' overrides per player, 'lobby' lists the other players.
const base=Date.UTC(2026,9,1,18);let clock=0;
const stat=(o={})=>({championId:412,kills:3,deaths:3,assists:8,spree:2,multi:1,quadra:0,penta:0,...o});
const lobby=(entries=[])=>entries.map(([puuid,with0,with1,win])=>({puuid,name:puuid.toUpperCase()+'#EUNE',champion:'Ahri',championId:103,with:[with0,with1],win}));
const vs=(id,winner,o={})=>({id,queue:'solo',kind:'opponents',at:new Date(base+(clock+=(o.gapHours??20))*3600000).toISOString(),duration:o.duration??1680,winner,teamWon:null,surrender:Boolean(o.surrender),champions:o.champions||['Thresh','Rengar'],stats:[stat(o.a),stat(o.b)],lobby:lobby(o.lobby),statsVersion:2});
const duo=(id,teamWon,o={})=>({id,queue:'solo',kind:'teammates',at:new Date(base+(clock+=(o.gapHours??20))*3600000).toISOString(),duration:1700,winner:null,teamWon,champions:['Thresh','Rengar'],stats:[stat(o.a),stat(o.b)],lobby:lobby(o.lobby),statsVersion:2});
const cursed=w=>[['x9',w===1,w===0,false]]; // x9 is always on the losing side

const records=[
 vs('G1',0,{lobby:cursed(0)}),
 vs('G2',0,{lobby:cursed(0)}),
 vs('G3',0,{lobby:cursed(0)}),                       // third straight win, x9 seen 3 times on the losing side
 vs('BORING',0,{gapHours:2}),                         // nothing new: streak of 4 is not a milestone
 vs('SNAP',1,{a:{kills:1,deaths:9,assists:4},b:{kills:16,deaths:2,assists:5,spree:11}}), // ends a 4-game run
 vs('LIE',0,{champions:['Elise','DrMundo'],a:{kills:1,deaths:4,assists:9},b:{kills:9,deaths:1,assists:4}}),           // loser has the far better KDA
 vs('STAR',1,{lobby:[['top1',false,true,true]]}),
 duo('D1',true),duo('D2',true),duo('D3',true),duo('D4',true),
 duo('PENTA',false,{b:{kills:12,penta:1}})
];
const top=[{puuid:'top1',lp:3300,tier:'CHALLENGER'}];
const out=buildNews(records,undefined,top);
const byGame=id=>out.articles.filter(a=>a.match?.id===id);
const types=out.articles.map(a=>a.type);

assert.equal(byGame('G1')[0].type,'first');
assert.ok(byGame('G3').some(a=>a.type==='streak'&&a.headline.includes('three')),'A third straight win is news.');
assert.equal(byGame('BORING').length,0,'Games with nothing new stay out of the feed.');
const snap=byGame('SNAP').find(a=>a.tag==='h2h');
assert.equal(snap.type,'snap');assert.ok(snap.headline.includes('regelepetras2006')||snap.lede.includes('regelepetras2006'));
assert.ok(snap.facts.some(f=>f.includes('11-kill')),'Secondary angles become supporting facts.');
assert.ok(snap.facts.some(f=>f.includes('1/9/4')));
assert.equal(byGame('LIE')[0].type,'kdalie');assert.ok(byGame('LIE')[0].headline.includes('Dr. Mundo'),'Internal champion names are made readable.');assert.equal(byGame('LIE')[0].hero,'DrMundo','Splash art keeps the internal name.');assert.ok(byGame('LIE')[0].headline.includes('9/1/4')||byGame('LIE')[0].lede.includes('9/1/4'));
assert.ok(byGame('STAR').some(a=>a.type==='starwin'&&a.headline.includes('#1')));
const curse=out.articles.find(a=>a.type==='facecurse');
assert.ok(curse&&curse.headline.includes('X9')&&!curse.headline.includes('#EUNE')&&curse.tag==='feature','Someone always on the losing side becomes a feature, named without the tag.');
assert.ok(curse.facts.some(f=>f.includes('0–3')));
assert.ok(byGame('D4').some(a=>a.type==='duowin'&&a.headline.includes('4')));
assert.ok(byGame('PENTA').some(a=>a.type==='penta'&&a.headline.includes('regelepetras2006')));
assert.deepEqual(out.series.wins,[5,2]);assert.equal(out.series.total,7);assert.deepEqual(out.series.streak,{who:1,n:1});
assert.equal(out.results[0].id,'STAR');assert.equal(out.results.length,7);
assert.equal(out.faces[0].name,'X9#EUNE');assert.deepEqual(out.faces[0].side,[0,3]);
for(let i=1;i<out.articles.length;i++)assert.ok(out.articles[i-1].at>=out.articles[i].at,'Newest first.');
assert.deepEqual(buildNews(records,undefined,top),out,'Generation is deterministic.');
assert.ok(!JSON.stringify(out).includes('puuid')&&!JSON.stringify(out).includes('"top1"'),'Other players are never identified by puuid.');
assert.ok(types.every(t=>t),'Every article has a type.');
// Records without the new fields still produce results without crashing.
const legacy=buildNews([{id:'OLD',queue:'solo',kind:'opponents',at:'2026-01-01T00:00:00Z',duration:1500,winner:1,champions:['Ahri','Zed'],stats:[{kills:1,deaths:2,assists:3},{kills:4,deaths:1,assists:2}]}]);
assert.equal(legacy.results.length,1);assert.equal(legacy.articles[0].type,'first');
console.log('Passed: news angles, boring-game filter, streak snaps, KDA upsets, ladder stars, familiar-face features, duo streaks, pentas, determinism and privacy.');

// Endpoint: reads stored records, reports games still missing details, never leaks puuids.
const values=new Map([['matchups-all.json',JSON.stringify({records:[...records,{id:'V1',queue:'solo',kind:'opponents',at:'2026-01-01T00:00:00Z',winner:0,statsVersion:1}]})],['apex-top.json',JSON.stringify({at:'2026-11-18T00:00:00Z',top})]]);
const BUCKET={async get(k){return values.has(k)?{json:async()=>JSON.parse(values.get(k))}:null;},async put(k,v){values.set(k,v);}};
const r=await worker.fetch(new Request('https://t.example/api/news'),{BUCKET});assert.equal(r.status,200);
const d=await r.json();assert.equal(d.pending,1);assert.equal(d.ladderAt,'2026-11-18T00:00:00Z');assert.ok(d.articles.length>5);assert.ok(!JSON.stringify(d).includes('puuid'));
assert.equal((await worker.fetch(new Request('https://t.example/api/news'),{})).status,503);
assert.equal((await worker.fetch(new Request('https://t.example/api/news',{method:'POST'}),{BUCKET})).status,405);

// Public match results hide the stored lobby.
const m=await(await worker.fetch(new Request('https://t.example/api/matchups'),{BUCKET:{...BUCKET,async get(k){return k==='matchups-all.json'?{json:async()=>({...JSON.parse(values.get(k)),historyScope:'available',ids:[[],[]],exhausted:[true,true],pending:[]})}:null;}}})).json();
assert.ok(m.records.length>0);assert.ok(m.records.every(x=>!('lobby' in x)));assert.ok(!JSON.stringify(m).includes('puuid'));

// Page: navigation on every page, then the client renders hero, day groups, sidebar and the empty state.
for(const path of ['/','/live/','/whos-fault/'])assert.ok((await(await worker.fetch(new Request('https://t.example'+path),{})).text()).includes('<a href="/news/"'),'News link on '+path);
const page=await(await worker.fetch(new Request('https://t.example/news/'),{})).text();
assert.ok(page.includes('href="/news/" aria-current="page"'));assert.ok(page.includes('<title>News · Schizo Battle</title>'));
const els=new Map();const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',hidden:false,setAttribute(){}});return els.get(id);};
const ctx=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[]},fetch:()=>new Promise(()=>{}),setTimeout:()=>0,setInterval(){},Intl,console});
vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1],ctx);
vm.runInContext('news='+JSON.stringify(d)+';render()',ctx);
assert.ok(el('hero').innerHTML.includes('hero-card'));assert.ok(el('hero').innerHTML.includes('splash_centered_0.jpg'));
assert.ok(el('feed').innerHTML.includes('day-title'));assert.ok(el('feed').innerHTML.includes('<details class="story">'));
assert.ok(el('feed').innerHTML.includes('class="who-b">regelepetras2006</span>'),'Player names are coloured.');
assert.ok(el('series').innerHTML.includes('<b>5</b>'));assert.equal((el('results').innerHTML.match(/result-row/g)||[]).length,7);
assert.equal(el('faces-box').hidden,false);assert.ok(el('faces').innerHTML.includes('X9#EUNE'));
assert.ok(el('news-sub').textContent.includes('stories from 12 shared games'));
vm.runInContext('news={articles:[],results:[],series:{wins:[0,0],total:0,streak:{who:null,n:0},form:[]},faces:[],gamesRead:0,pending:0};render()',ctx);
assert.ok(el('hero').innerHTML.includes('No headlines yet'));assert.equal(el('faces-box').hidden,true);assert.ok(el('series').innerHTML.includes('No head-to-head'));
console.log('Passed: news endpoint, pending detail count, hidden lobby in public results, navigation links, and page rendering with stories, sidebar and empty state.');
