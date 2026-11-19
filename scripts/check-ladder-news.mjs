import assert from 'node:assert/strict';
import worker,{buildLadderNews} from '../worker/index.js';

// Synthetic Solo/Duo snapshots: [lp0, lp1] in Grandmaster unless a tier is given.
const t0=Date.UTC(2026,10,1,12);
const snap=(h,a,b,tiers=['GRANDMASTER','GRANDMASTER'])=>({at:new Date(t0+h*36e5).toISOString(),source:'Riot API',queues:{solo:[{tier:tiers[0],rank:'I',lp:a,wins:1,losses:1},{tier:tiers[1],rank:'I',lp:b,wins:1,losses:1}]}});
const types=list=>list.map(a=>a.type);

// Nothing changes on the first snapshot, whatever it holds.
assert.deepEqual(buildLadderNews([snap(0,1600,1200)]),[]);
assert.deepEqual(buildLadderNews([]),[]);

// A clear pass is one story, with the old leader's best lead as a fact.
let out=buildLadderNews([snap(0,1300,1600),snap(30,1300,1500),snap(60,1420,1340)]);
assert.deepEqual(types(out),['overtake']);
assert.ok(out[0].headline.includes('Respectful Jew')&&out[0].tag==='ladder'&&out[0].match===null);
assert.ok(out[0].facts.some(f=>f.includes('300 LP')),'Old leader’s biggest lead is a fact.');
assert.ok(out[0].lede.includes('at least'),'A lead that started before tracking is not given an exact length.');

// Margin: going 10 LP ahead is not a lead change.
assert.deepEqual(buildLadderNews([snap(0,1300,1400),snap(30,1410,1400)]),[]);

// Flip-flopping: only the first pass is news; quick swaps after it are not.
const flips=[snap(0,1300,1400)];let h=0;for(let i=0;i<12;i++){h+=3;flips.push(i%2?snap(h,1350,1400):snap(h,1450,1400));}
out=buildLadderNews(flips);assert.equal(types(out).filter(t=>t==='overtake').length,1,'Back-and-forth leads make one story.');

// Retaking a lead lost under 48h ago is not news; after that it is.
out=buildLadderNews([snap(0,1300,1400),snap(30,1450,1400),snap(60,1350,1400),snap(80,1450,1400)]);
assert.equal(types(out).filter(t=>t==='overtake').length,1,'Retakes 30h and 20h after losing the lead are not news.');
out=buildLadderNews([snap(0,1300,1400),snap(30,1450,1400),snap(60,1350,1400),snap(200,1450,1400)]);
assert.equal(types(out).filter(t=>t==='overtake').length,2,'Retaking 140h after losing it is news.');

// Milestones fire once per mark, never again after dipping back.
out=buildLadderNews([snap(0,1400,900),snap(10,1510,900),snap(20,1480,900),snap(30,1520,900),snap(40,1760,900)]);
assert.deepEqual(out.filter(a=>a.type==='milestone').map(a=>a.headline.match(/\d,\d{3}/)[0]),['1,500','1,750']);
// Below Master, LP is per division, so milestones never fire.
assert.deepEqual(buildLadderNews([snap(0,10,10,['DIAMOND','DIAMOND']),snap(10,90,10,['DIAMOND','DIAMOND'])]).filter(a=>a.type==='milestone'),[]);

// Challenger: an actual promotion, outranking anything else in the same update.
out=buildLadderNews([snap(0,1200,1700),snap(20,1200,1760,['GRANDMASTER','CHALLENGER'])]);
assert.equal(out.at(-1).type,'challenger');assert.ok(out.at(-1).headline.includes('regelepetras2006'));assert.ok(out.at(-1).facts.some(f=>f.includes('1,750')),'Same-update milestone becomes a fact.');
// Bouncing in and out of Challenger within a week is one story.
out=buildLadderNews([snap(0,1200,1700),snap(20,1200,1760,['GRANDMASTER','CHALLENGER']),snap(40,1200,1700),snap(60,1200,1765,['GRANDMASTER','CHALLENGER'])]);
assert.equal(types(out).filter(t=>t==='challenger').length,1);

// Gap record: needs 150+, 50 beyond the last reported record, and a day between stories.
out=buildLadderNews([snap(0,1400,1350),snap(10,1400,1150),snap(20,1400,1110),snap(30,1400,1050),snap(60,1400,1030)]);
assert.deepEqual(out.filter(a=>a.type==='gap').map(a=>a.headline.match(/\d+/)[0]),['250','370']);

// Cross-tier comparison works and unranked snapshots are skipped.
out=buildLadderNews([snap(0,80,20,['MASTER','DIAMOND']),{at:new Date(t0+5*36e5).toISOString(),queues:{solo:[{tier:'UNRANKED',rank:'',lp:0},{tier:'UNRANKED',rank:'',lp:0}]}},snap(10,80,30,['DIAMOND','MASTER'])]);
assert.deepEqual(types(out),['overtake']);assert.ok(out[0].lede.includes('Diamond I 80 LP'));

// Cap: only the latest five LP stories survive.
const many=[snap(0,1000,1000)];for(let i=1;i<=30;i++)many.push(snap(i*100,i%2?1100:900,1000));
out=buildLadderNews(many);assert.equal(out.length,5);assert.ok(out.every((a,i)=>!i||out[i-1].at<a.at));
assert.deepEqual(buildLadderNews(many),out,'Deterministic.');
console.log('Passed: LP race stories — lead margin, flip-flop cooldown, retakes, milestones once, Challenger promotions, gap records, cross-tier ranks, cap.');

// Endpoint merges LP stories with game stories; a store without list() still works.
const values=new Map([['matchups-all.json',JSON.stringify({records:[]})],['snapshots/2.json',JSON.stringify(snap(0,1300,1600))],['snapshots/1.json',JSON.stringify(snap(60,1420,1340))]]);
const BUCKET={async get(k){return values.has(k)?{json:async()=>JSON.parse(values.get(k))}:null;},async list({prefix}){return {objects:[...values.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};}};
const d=await(await worker.fetch(new Request('https://t.example/api/news'),{BUCKET})).json();
assert.deepEqual(d.articles.map(a=>a.type),['overtake']);assert.equal(d.lpUpdates,1);
const noList=await worker.fetch(new Request('https://t.example/api/news'),{BUCKET:{get:BUCKET.get}});assert.equal(noList.status,200);
const page=await(await worker.fetch(new Request('https://t.example/news/'),{})).text();assert.ok(page.includes("ladder:['LP race'"));
console.log('Passed: news endpoint includes LP race stories.');
