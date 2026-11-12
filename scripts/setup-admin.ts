// Configure the web administrator without placing a password in command arguments or logs.
// node scripts/setup-admin.ts --config /path/server.json [--username admin]
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { adminAccount, createAdmin } from '../src/server/admin-auth.ts';
import { loadServerConfig } from '../src/server/config.ts';
import { openDb } from '../src/server/db.ts';

const { values } = parseArgs({ options: { config: { type: 'string' }, username: { type: 'string', default: 'admin' } } });
if (!values.config) throw new Error('--config is required');
const db = openDb(loadServerConfig(values.config).dbPath);
try {
  if (adminAccount(db)) {
    console.log('管理员账号已配置，未更改现有密码。');
  } else {
    const password = randomBytes(24).toString('base64url');
    const file = join(dirname(values.config), 'admin-initial-password');
    writeFileSync(file, `用户名：${values.username}\n初始密码：${password}\n首次登录后请设置自己的密码。\n`, { mode: 0o600, flag: 'wx' });
    try { await createAdmin(db, values.username!, password, new Date(), true); }
    catch (error) { unlinkSync(file); throw error; }
    console.log(`管理员账号已配置。初始密码保存在 ${file}（仅当前用户可读），首次登录需更改密码。`);
  }
} finally { db.close(); }
