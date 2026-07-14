// Helper spawned by the resilience test to exercise concurrent opens of one DB.
// Reads STICKIES_DB from env, opens via the store (runs migration), prints "ok".
import { readStickies } from '../src/store.js';
readStickies({ project_path: '/race' });
console.log('ok');
