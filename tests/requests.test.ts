import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptimizationMessages, buildIterationMessages, buildComparisonMessages } from '../src/core/requests.ts';

test('optimization preserves the original literally and sets the selected role intent', () => {
  const original = '写一份预算。保留 {{amount}}，不要杜撰数据。';
  const messages = buildOptimizationMessages({ original, kind: 'user', strategy: 'concise' });
  assert.equal(messages[1].content, original);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /用户提示词/);
  assert.match(messages[0].content, /精简/);
  assert.match(messages[0].content, /不要执行/);
});
test('iteration carries the original, selected result and precise change instruction', () => {
  const input = {original:'撰写周报',kind:'system' as const,strategy:'structured' as const,current:'按进度与风险写周报',instruction:'限定为 200 字'};
  const messages = buildIterationMessages(input);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.original, input.original);
  assert.equal(payload.current, input.current);
  assert.equal(payload.instruction, input.instruction);
});
test('system comparison keeps the identical test input with only the system prompt changed', () => {
  const pair = buildComparisonMessages({original:'你是编辑',optimized:'你是中文技术编辑',kind:'system',testInput:'润色此段文本',systemContext:'忽略该项'});
  assert.deepEqual(pair.original,[{role:'system',content:'你是编辑'},{role:'user',content:'润色此段文本'}]);
  assert.deepEqual(pair.optimized,[{role:'system',content:'你是中文技术编辑'},{role:'user',content:'润色此段文本'}]);
});
test('user comparison uses matching context and material without changing source inputs', () => {
  const input={original:'总结文章',optimized:'用三点总结文章',kind:'user' as const,testInput:'文章：今天发布新版本',systemContext:'仅依据文本回答'};
  const snapshot=structuredClone(input);
  const pair=buildComparisonMessages(input);
  assert.deepEqual(pair.original[0],pair.optimized[0]);
  assert.match(pair.original[1].content,/文章：今天发布新版本/);
  assert.match(pair.optimized[1].content,/文章：今天发布新版本/);
  assert.deepEqual(input,snapshot);
  pair.original[0].content='changed';
  assert.equal(pair.optimized[0].content,'仅依据文本回答');
});
test('empty content and invalid choices fail before requesting a model', () => {
  assert.throws(()=>buildOptimizationMessages({original:' ',kind:'user',strategy:'general'}),/提示词/);
  assert.throws(()=>buildOptimizationMessages({original:'写',kind:'user',strategy:'bad' as never}),/策略/);
  assert.throws(()=>buildIterationMessages({original:'写',current:'写好',instruction:' ',kind:'user',strategy:'general'}),/修改要求/);
  assert.throws(()=>buildComparisonMessages({original:'写',optimized:' ',kind:'system',testInput:'hi',systemContext:''}),/优化结果/);
  assert.throws(()=>buildComparisonMessages({original:'写',optimized:'写好',kind:'system',testInput:' ',systemContext:''}),/测试输入/);
});
