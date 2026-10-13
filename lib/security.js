import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export function redactSecrets(value) {
  return String(value)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, '[redacted-access-token]')
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, '[redacted-refresh-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/("?(?:access|refresh|access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|cookie)"?\s*[:=]\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/("?(?:access|refresh|access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|cookie)"?\s*[:=]\s*)[^\s&,}]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|id_token|token|client_secret|code_verifier|code|state|key)=)[^\s&#"']*/gi, '$1[redacted]')
    .replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}

async function assertRegularDestination(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Refusing symbolic link credential destination');
    if (!info.isFile()) throw new Error('Credential destination must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function writePrivateJson(file, payload) {
  const data = JSON.stringify(payload, null, 2);
  if (data === undefined) throw new Error('Credential data is not serializable');
  const target = resolve(file);
  const parent = dirname(target);
  await mkdir(parent, {recursive:true, mode:0o700});
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error('Credential parent must be a non-symbolic-link directory');
  }
  await assertRegularDestination(target);
  const temp = resolve(parent, `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  // Only this function's verified, same-directory, exclusively created file
  // may be removed in cleanup. Renaming never follows a destination symlink.
  if (dirname(temp) !== parent || temp === target) throw new Error('Unsafe credential temporary path');
  let handle;
  let owned = false;
  try {
    handle = await open(temp, 'wx', 0o600);
    owned = true;
    await handle.chmod(0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertRegularDestination(target);
    await rename(temp, target);
    owned = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned) await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
