// Child-process fixture: a CLI scan talks only to the synthetic demo endpoints and never loads credentials from a file.
import process from 'node:process';
import { demoData, demoFetch } from '../../dist/cli/demo.js';
globalThis.fetch = demoFetch(demoData(), Date.now);
process.loadEnvFile = () => { throw new Error('credential_loading_forbidden_in_fixture_scan'); };
