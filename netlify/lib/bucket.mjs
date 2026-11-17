// Adapt the existing storage interface to a persistent, site-wide Blobs store.
export function createBucket(store,seed={}){
 return {
  async get(key){
   const value=await store.get(key,{type:'text'});
   const text=value??(Object.hasOwn(seed,key)?JSON.stringify(seed[key]):null);
   return text===null?null:{json:async()=>JSON.parse(text)};
  },
  async put(key,value){await store.set(key,value);},
  async list({prefix='',limit=1000}={}){
   const keys=new Set(Object.keys(seed).filter(key=>key.startsWith(prefix)));
   for await(const page of store.list({prefix,paginate:true})){
    for(const blob of page.blobs)keys.add(blob.key);
   }
   return {objects:[...keys].sort().slice(0,limit).map(key=>({key}))};
  }
 };
}
