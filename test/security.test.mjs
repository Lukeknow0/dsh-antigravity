import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, chmod, symlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivateJson, redactSecrets } from '../lib/security.js';

async function directory(t) {
  const dir=await mkdtemp(join(tmpdir(),'antigravity-security-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
test('credential writes atomically replace JSON with restrictive permissions',async t=>{
  const dir=await directory(t);const file=join(dir,'accounts.json');
  await writePrivateJson(file,{refresh:'test-secret'});
  assert.equal((await stat(file)).mode & 0o777,0o600);
  await chmod(file,0o644);
  await writePrivateJson(file,{refresh:'new-test-secret'});
  assert.equal(JSON.parse(await readFile(file,'utf8')).refresh,'new-test-secret');
  assert.equal((await stat(file)).mode & 0o777,0o600);
  assert.deepEqual(await readdir(dir),['accounts.json']);
});
test('symlink destinations are refused without changing the target',async t=>{
  const dir=await directory(t);const target=join(dir,'target');const link=join(dir,'accounts.json');
  await writeFile(target,'unchanged');await symlink(target,link);
  await assert.rejects(writePrivateJson(link,{access:'test-token'}),/symbolic link/i);
  assert.equal(await readFile(target,'utf8'),'unchanged');
  assert.equal((await readdir(dir)).length,2);
});
test('cyclic serialization does not leave a credential temp file',async t=>{
  const dir=await directory(t);const value={};value.self=value;
  await assert.rejects(writePrivateJson(join(dir,'accounts.json'),value));
  assert.deepEqual(await readdir(dir),[]);
});
test('parallel private writes use unique temporary paths and preserve complete JSON',async t=>{
  const dir=await directory(t);const file=join(dir,'accounts.json');
  await Promise.all(Array.from({length:10},(_,n)=>writePrivateJson(file,{n,data:'test'})));
  const result=JSON.parse(await readFile(file,'utf8'));
  assert.equal(result.data,'test');assert.ok(Number.isInteger(result.n));
  assert.deepEqual(await readdir(dir),['accounts.json']);
});
test('logs redact JSON account fields, OAuth credentials, emails and URL query secrets',()=>{
  const input='{"access":"abc-access","refresh":"abc-refresh","email":"user@example.test","authorization":"Bearer abc-token"} https://example.test/callback?code=abc-code&state=abc-state&client_secret=abc-client';
  const result=redactSecrets(input);
  for(const secret of ['abc-access','abc-refresh','user@example.test','abc-token','abc-code','abc-state','abc-client'])assert.equal(result.includes(secret),false,secret);
});
