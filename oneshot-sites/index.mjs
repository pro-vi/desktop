import { kimiAdapter } from './kimi.mjs';

// Vendors whose tabs run on the one-shot engine instead of ChatGPTController.
const ADAPTERS = new Map([kimiAdapter].map((adapter) => [adapter.vendorId, adapter]));

export function oneShotAdapterFor(vendorId) {
  return ADAPTERS.get(String(vendorId || '').trim().toLowerCase()) || null;
}
