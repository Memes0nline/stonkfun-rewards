import process from 'node:process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
globalThis.fetch = () => { throw new Error('offline_network_forbidden'); };
process.loadEnvFile = () => { throw new Error('offline_credentials_forbidden'); };
const env = process.env;
process.env = new Proxy(env, { get(target, key) {
  if (key === 'HELIUS_API_KEY') throw new Error('offline_credential_read_forbidden');
  return Reflect.get(target, key);
} });
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (/(^|[\\/])\.env(?:[.\\/]|$)/i.test(String(path))) throw new Error('offline_env_read_forbidden');
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
