import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedDocument, validateRunRequest } from '../electron/security.ts';
test('only the exact local renderer document is allowed to use desktop IPC',()=>{
  const expected='file:///C:/app/dist/index.html';
  assert.equal(isTrustedDocument(expected,expected),true);
  assert.equal(isTrustedDocument(expected+'#history',expected),true);
  assert.equal(isTrustedDocument('file:///C:/app/dist/other.html',expected),false);
  assert.equal(isTrustedDocument('https://evil.invalid',expected),false);
  assert.equal(isTrustedDocument(expected+'?other=1',expected),false);
  assert.equal(isTrustedDocument('http://127.0.0.1:5173/evil','http://127.0.0.1:5173/'),false);
});
test('malformed IDs and oversized or empty messages fail before model access',()=>{
  const valid={requestId:'abc-123',modelId:'m1',messages:[{role:'user',content:'测试'}]};
  assert.doesNotThrow(()=>validateRunRequest(valid));
  assert.throws(()=>validateRunRequest({...valid,requestId:'../path'}));
  assert.throws(()=>validateRunRequest({...valid,messages:[{role:'tool',content:'x'}]}));
  assert.throws(()=>validateRunRequest({...valid,messages:[{role:'user',content:' '}]}));
  assert.throws(()=>validateRunRequest({...valid,messages:[{role:'user',content:'a'.repeat(800001)}]}));
});
