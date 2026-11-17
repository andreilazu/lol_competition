import {mkdir,writeFile} from 'node:fs/promises';
import worker from '../worker/index.js';

const page=await worker.fetch(new Request('https://build.example/'),{});
if(!page.ok)throw new Error('Could not build the home page.');
await mkdir('public',{recursive:true});
await writeFile('public/index.html',await page.text());
console.log('Netlify home page built in public/.');
const fault=await worker.fetch(new Request('https://build.example/whos-fault/'),{});
if(!fault.ok)throw new Error('Could not build the blame page.');
await mkdir('public/whos-fault',{recursive:true});
await writeFile('public/whos-fault/index.html',await fault.text());
console.log('Blame page built in public/whos-fault/.');
const livePage=await worker.fetch(new Request('https://build.example/live/'),{});
if(!livePage.ok)throw new Error('Could not build the live page.');
await mkdir('public/live',{recursive:true});
await writeFile('public/live/index.html',await livePage.text());
console.log('Live page built in public/live/.');
