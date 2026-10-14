import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { streamChat, chatEndpoint } from '../src/core/client.ts';

async function fixture(handler: http.RequestListener) {
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address() as {port:number};
  return {baseUrl:`http://127.0.0.1:${address.port}/v1`,close:async()=>{server.closeAllConnections();server.close();await once(server,'close');}};
}
const model=(baseUrl:string)=>({id:'m1',name:'Local fixture',baseUrl,model:'fixture-text',temperature:0.4,apiKey:'test-private-key'});
const messages=[{role:'user' as const,content:'测试'}];

test('endpoint preserves explicit API paths and rejects credential-bearing or nonlocal HTTP URLs',()=>{
  assert.equal(chatEndpoint('https://example.org/v1/'),'https://example.org/v1/chat/completions');
  assert.equal(chatEndpoint('https://example.org/api/chat/completions'),'https://example.org/api/chat/completions');
  assert.equal(chatEndpoint('http://localhost:11434'),'http://localhost:11434/v1/chat/completions');
  assert.throws(()=>chatEndpoint('https://user:pass@example.org/v1'));
  assert.throws(()=>chatEndpoint('http://example.org/v1'));
});
test('SSE reconstructs split UTF-8, CRLF events and ignores reasoning-only deltas',async()=>{
  let seen:any; let auth=''; let requestPath='';
  const api=await fixture(async(req,res)=>{
    auth=String(req.headers.authorization);requestPath=req.url??'';let body='';for await(const part of req)body+=part;seen=JSON.parse(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const bytes=Buffer.from(': heartbeat\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for(let i=0;i<bytes.length;i+=3)res.write(bytes.subarray(i,i+3));res.end();
  });
  try {const chunks:string[]=[];const result=await streamChat(model(api.baseUrl),messages,new AbortController().signal,d=>chunks.push(d));
    assert.equal(result.content,'你好世界');assert.equal(chunks.join(''),'你好世界');
    assert.equal(auth,'Bearer test-private-key');assert.equal(requestPath,'/v1/chat/completions');assert.equal(seen.stream,true);assert.deepEqual(seen.messages,messages);
  } finally {await api.close();}
});
test('non-streaming JSON responses are accepted and delivered to the renderer',async()=>{
  const api=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'完整输出'}}]}));});
  try {let delivered='';const result=await streamChat(model(api.baseUrl),messages,new AbortController().signal,d=>delivered+=d);assert.equal(result.content,'完整输出');assert.equal(delivered,'完整输出');}finally{await api.close();}
});
test('401 errors remain useful without exposing response body or API key',async()=>{
  const api=await fixture((_req,res)=>{res.writeHead(401);res.end('secret reflected test-private-key');});
  try{await assert.rejects(streamChat(model(api.baseUrl),messages,new AbortController().signal,()=>{}),e=>{assert.match(String(e),/401|密钥/);assert.doesNotMatch(String(e),/test-private-key|reflected/);return true;});}finally{await api.close();}
});
test('empty or prematurely terminated streams cannot be reported as completed',async()=>{
  for(const body of ['data: [DONE]\n\n','data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n']){
    const api=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(body);});
    try{await assert.rejects(streamChat(model(api.baseUrl),messages,new AbortController().signal,()=>{}),/空|中断|完成/);}finally{await api.close();}
  }
});
test('cancel and timeout abort pending provider requests',async()=>{
  const api=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();});
  try{const cancel=new AbortController();const running=streamChat(model(api.baseUrl),messages,cancel.signal,()=>{});cancel.abort();await assert.rejects(running,/取消/);
    await assert.rejects(streamChat(model(api.baseUrl),messages,new AbortController().signal,()=>{}, {timeoutMs:40}),/超时/);
  }finally{await api.close();}
});
test('provider redirects are refused before sending credentials to a new destination',async()=>{
  const api=await fixture((_req,res)=>{res.writeHead(302,{location:'https://example.org/collect'});res.end();});
  try{await assert.rejects(streamChat(model(api.baseUrl),messages,new AbortController().signal,()=>{}),/连接|请求|重定向/);}finally{await api.close();}
});
test('non-streaming truncated and filtered results are rejected instead of saved as completed',async()=>{
  for(const finish_reason of ['length','content_filter']){
    const api=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'截断内容'},finish_reason}]}));});
    try{await assert.rejects(streamChat(model(api.baseUrl),messages,new AbortController().signal,()=>{}),/未完成/);}finally{await api.close();}
  }
});
