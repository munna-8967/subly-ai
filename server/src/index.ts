import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await createApp(config);
const port = await app.listen();

const { transcription, translation } = app.providers;
console.log('');
console.log(`  Subly AI is running:  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
console.log(`  Data folder:          ${config.dataDir}`);
console.log(`  Transcription:        ${transcription.isConfigured() ? `enabled (${transcription.name})` : 'NOT configured - manual editing only (set OPENROUTER_API_KEY)'}`);
console.log(`  Translation:          ${translation.isConfigured() ? `enabled (${translation.name})` : 'NOT configured - type translations manually'}`);
console.log(`  Burned-in video:      ${app.renders.support.available ? 'available' : `unavailable - ${app.renders.support.reason}`}`);
const b = config.billing;
console.log(`  Accounts + credits:   enabled (database: ${config.dbPath}); ${b.freeMonthlyCredits} free credits per month`);
console.log(`  Payments:             ${b.paymentsMode === 'stripe' ? 'Stripe (real payments)' : b.paymentsMode === 'demo' ? 'DEMO MODE - fake checkout, NO real money. Do not use on a public site (set PAYMENTS_MODE=stripe or off)' : `OFF${b.paymentsNote ? ` - ${b.paymentsNote}` : ''}`}`);
if (b.paymentsNote && b.paymentsMode !== 'off') console.log(`  Payments note:        ${b.paymentsNote}`);
console.log('');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received, shutting down...`);
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
