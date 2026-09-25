// Child-process guard: an offline saved report must never load credentials or call fetch.
import process from 'node:process';
globalThis.fetch = () => { throw new Error('network_forbidden_in_saved_report'); };
process.loadEnvFile = () => { throw new Error('credential_loading_forbidden_in_saved_report'); };
