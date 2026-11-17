import http from 'node:http';
import worker from '../worker/index.js';
http.createServer(async(req,res)=>{try{const result=await worker.fetch(new Request('http://localhost:4173'+req.url,{method:req.method,headers:req.headers}),{});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());}catch{res.writeHead(500);res.end('Preview failed');}}).listen(4173,'127.0.0.1',()=>console.log('Local: http://localhost:4173'));
