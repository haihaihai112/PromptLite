import type { Message, RunResult } from '../shared/contracts.js';

export interface ModelConnection { id: string; name: string; baseUrl: string; model: string; temperature: number; apiKey: string }
const MAX_CONTENT = 100_000;
export function chatEndpoint(baseUrl: string): string {
  let url: URL;
  try { url=new URL(baseUrl.trim()); } catch { throw new Error('模型地址无效，请填写完整的 HTTPS 或本地 HTTP 地址。'); }
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))
    throw new Error('模型地址需要 HTTPS；本地服务可使用 HTTP。地址不能包含账号、密码、查询参数或片段。');
  const base=url.pathname.replace(/\/+$/,'');
  url.pathname=base.endsWith('/chat/completions')?base:`${base||'/v1'}/chat/completions`;
  return url.toString();
}
export function validateMessages(messages: unknown): asserts messages is Message[] {
  if(!Array.isArray(messages)||messages.length<1||messages.length>32)throw new Error('消息数量无效。');
  let total=0;
  for(const item of messages){
    if(!item||!['system','user','assistant'].includes(item.role)||typeof item.content!=='string'||!item.content.trim())throw new Error('消息角色或内容无效。');
    total+=item.content.length;
  }
  if(total>800_000)throw new Error('请求内容过长，请缩短提示词和测试材料。');
}

export async function streamChat(model: ModelConnection, messages: Message[], signal: AbortSignal,
  onDelta: (delta: string) => void, options: {timeoutMs?: number} = {}): Promise<RunResult> {
  validateMessages(messages);
  const endpoint=chatEndpoint(model.baseUrl);
  const controller=new AbortController();
  let timedOut=false;
  const cancel=()=>controller.abort();
  signal.addEventListener('abort',cancel,{once:true});
  if(signal.aborted)controller.abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??120_000);
  let content='';
  const append=(delta: unknown)=>{
    if(typeof delta!=='string'||!delta)return;
    if(content.length+delta.length>MAX_CONTENT)throw new Error('模型输出过长，已停止接收。请限制输出长度。');
    content+=delta;onDelta(delta);
  };
  try {
    const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:controller.signal,
      headers:{'Content-Type':'application/json',Accept:'text/event-stream',...(model.apiKey?{Authorization:`Bearer ${model.apiKey}`}:{})},
      body:JSON.stringify({model:model.model,messages,temperature:model.temperature,stream:true})});
    if(!response.ok){
      await response.body?.cancel();
      if(response.status===401||response.status===403)throw new Error(`模型鉴权失败（${response.status}），请检查 API Key 和访问权限。`);
      if(response.status===429)throw new Error('请求受限（429），请检查额度或稍后重试。');
      if(response.status===404)throw new Error('接口或模型不存在（404），请检查模型 ID 与 Base URL。');
      throw new Error(`模型服务返回 HTTP ${response.status}，请检查服务状态和接口设置。`);
    }
    const media=response.headers.get('content-type')??'';
    if(media.includes('application/json')){
      const text=await readLimitedBody(response,2_000_000);
      let result:any;
      try{result=JSON.parse(text);}catch{throw new Error('模型返回的 JSON 数据格式无效。');}
      if(result.error)throw new Error('模型服务返回了错误，请检查模型与请求参数。');
      if(result.choices?.[0]?.finish_reason==='length')throw new Error('模型因长度限制停止，结果未完成。请缩短输出要求。');
      if(result.choices?.[0]?.finish_reason==='content_filter')throw new Error('模型服务过滤了本次输出，结果未完成。');
      append(result.choices?.[0]?.message?.content);
    } else {
      if(!response.body)throw new Error('模型服务没有返回响应内容。');
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let done=false;let finished=false;
      const event=(block: string)=>{
        const payload=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!payload)return;
        if(payload.trim()==='[DONE]'){done=true;return;}
        let result:any;
        try{result=JSON.parse(payload);}catch{throw new Error('模型返回的流式数据格式无效。');}
        if(result.error)throw new Error('模型服务在输出途中返回了错误，结果未完成。');
        const choice=result.choices?.[0];
        if(choice?.finish_reason==='length')throw new Error('模型因长度限制停止，结果未完成。请缩短输出要求。');
        if(choice?.finish_reason==='content_filter')throw new Error('模型服务过滤了本次输出，结果未完成。');
        append(choice?.delta?.content);
        if(choice?.finish_reason)finished=true;
      };
      try{
        while(!done){
          const part=await reader.read();
          buffer+=decoder.decode(part.value,{stream:!part.done});
          if(buffer.length>2_000_000)throw new Error('模型返回的数据块过大，已停止接收。');
          let boundary: RegExpExecArray|null;
          while((boundary=/\r?\n\r?\n/.exec(buffer))!==null){const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);event(block);if(done)break;}
          if(part.done){if(buffer.trim())event(buffer);break;}
        }
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(!done&&!finished)throw new Error('流式连接中断，结果未完成，请重试。');
    }
    if(signal.aborted)throw new Error('请求已取消，结果未完成。');
    if(!content.trim())throw new Error('模型返回了空结果，请检查模型或重试。');
    return {content};
  } catch(error) {
    if(signal.aborted)throw new Error('请求已取消，结果未完成。');
    if(timedOut)throw new Error('模型请求超时（120 秒），请检查网络或改用响应较快的模型。');
    if(error instanceof TypeError)throw new Error('无法连接模型服务。请检查地址、网络、证书及接口是否允许请求。');
    if(error instanceof Error){
      const message=model.apiKey?error.message.split(model.apiKey).join('[已隐藏]'):error.message;
      throw new Error(message);
    }
    throw new Error('模型请求失败，请重试。');
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
}
async function readLimitedBody(response: Response, limit: number): Promise<string> {
  if(!response.body)return '';
  const reader=response.body.getReader();const decoder=new TextDecoder();let text='';let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw new Error('模型响应过大。');text+=decoder.decode(part.value,{stream:true});}return text+decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
