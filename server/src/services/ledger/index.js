import env from '../../config/env.js';
import log from '../../utils/logger.js';
import localChain from './localChain.js';
import fabricChain from './fabricChain.js';

// Single entry point the rest of the application talks to. Which ledger is
// behind it is a deployment decision (FABRIC_ENABLED), never a code decision.
let active = null;

export async function initLedger() {
  const chosen = env.fabric.enabled ? fabricChain : localChain;
  try {
    await chosen.init();
    active = chosen;
  } catch (err) {
    if (env.fabric.enabled) {
      // Do not silently downgrade to the weaker ledger: an institute that
      // asked for Fabric must be told its network is unreachable, not handed
      // credentials anchored somewhere else.
      log.error(`fabric init failed: ${err.message}`);
      throw err;
    }
    throw err;
  }
  log.info(`ledger backend: ${active.backend}`);
  return active;
}

export function ledger() {
  if (!active) throw new Error('ledger not initialised - call initLedger() at startup');
  return active;
}

export function ledgerBackend() {
  return active ? active.backend : 'uninitialised';
}

export default { initLedger, ledger, ledgerBackend };
