import type { RunRequest } from '../src/shared/contracts.js';
import { validateMessages } from '../src/core/client.ts';

export function isTrustedDocument(frameUrl: string, expectedUrl: string): boolean {
  try { const frame=new URL(frameUrl);const expected=new URL(expectedUrl);frame.hash='';expected.hash='';return frame.href===expected.href; }catch{return false;}
}
export function validateId(value: unknown): asserts value is string {
  if(typeof value!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))throw new Error('请求标识无效。');
}
export function validateRunRequest(value: unknown): asserts value is RunRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请求格式无效。');
  const request=value as RunRequest;
  validateId(request.requestId);validateId(request.modelId);validateMessages(request.messages);
}
