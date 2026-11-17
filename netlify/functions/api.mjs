import {getStore} from '@netlify/blobs';
import worker from '../../worker/index.js';
import {createBucket} from '../lib/bucket.mjs';
import seed from '../lib/bootstrap.mjs';

export default async function handler(request){
 const store=getStore({name:'rift-rivals',consistency:'strong'});
 return worker.fetch(request,{
  RIOT_API_KEY:process.env.RIOT_API_KEY,
  MATCHUP_BUDGET_MS:35000,
  BUCKET:createBucket(store,seed)
 });
}

export const config={path:'/api/*'};
