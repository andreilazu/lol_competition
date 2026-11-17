import {mkdir,writeFile} from 'node:fs/promises';
import worker from '../worker/index.js';

const page=await worker.fetch(new Request('https://build.example/'),{});
if(!page.ok)throw new Error('Could not build the home page.');
await mkdir('public',{recursive:true});
await writeFile('public/index.html',await page.text());
console.log('Netlify home page built in public/.');
