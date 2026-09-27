import { ethers } from 'ethers';
import * as fs from 'fs';
import { config } from './config';
import type { KeyStore } from './keyStore';
import { sseManager } from './sseManager';
import { performErasure } from './erasureProof';
import { rekeyAsset } from './rekey';

function loadDeployment(): { address: string; abi: ethers.InterfaceAbi } {
  const raw = fs.readFileSync(config.deploymentFile, 'utf8');
  const deployment = JSON.parse(raw);
  return deployment.contracts.AssetRegistry;
}

// Heartbeat interval and per-check timeout for detecting a dead/zombie
// connection that never fires 'close' or 'error' (see attach() below).
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

// The heartbeat above only proves the WebSocket *transport* is alive
// (provider.getBlockNumber() succeeds) — it can't prove the contract's
// `eth_subscribe(logs)` subscription is still delivering. In practice,
// Hardhat's WS server has been observed to silently stop pushing log
// notifications after a burst of many transactions in quick succession,
// while staying fully responsive to ordinary RPC calls — so the heartbeat
// keeps passing even though no more events will ever arrive on this
// subscription. There's no cheap way to directly ask "is my logs
// subscription still live," so instead we force a full resubscribe on a
// fixed interval regardless of apparent health, bounding how long this
// failure mode can go undetected to one interval instead of indefinitely.
const FORCED_RESUBSCRIBE_INTERVAL_MS = 120_000;

async function attach(keyStore: KeyStore, onDisconnect: () => void): Promise<() => void> {
  const { address, abi } = loadDeployment();
  const provider = new ethers.WebSocketProvider(config.l1WsUrl);

  // Verify the connection is live before setting up listeners.
  // getNetwork() will throw (and be caught by the retry loop) if Hardhat is unreachable.
  await provider.getNetwork();

  // Sentinel so a stale in-flight heartbeat check (started before teardown,
  // resolving/rejecting after) can't trigger a second, redundant reconnect
  // for a connection we've already torn down ourselves.
  let stale = false;

  const contract = new ethers.Contract(address, abi, provider);
  console.log(`[L2] Subscribed to AssetRegistry @ ${address} via ${config.l1WsUrl}`);

  const onUserRegistered = (user: string, txId: bigint) => {
    const id = txId.toString();
    keyStore.storeKey(id, user);
    console.log(`[L2] UserRegistered  user=${user} txId=${id}`);
    sseManager.push(user, 'KEY_READY', { txId: id, purpose: 'USER_PII', user });
  };

  const onUserApproved = (user: string, txId: bigint) => {
    const id = txId.toString();
    keyStore.storeKey(id, user);
    console.log(`[L2] UserApproved    user=${user} txId=${id}`);
  };

  const onAssetCreated = (
    assetId: bigint,
    owner: string,
    name: string,
    txId: bigint,
  ) => {
    const id = txId.toString();
    keyStore.storeKey(id, owner);
    keyStore.storeAssetTxId(assetId.toString(), id);
    console.log(`[L2] AssetCreated    owner=${owner} assetId=${assetId} txId=${id}`);
    sseManager.push(owner, 'KEY_READY', {
      txId: id,
      purpose: 'ASSET_METADATA',
      assetId: assetId.toString(),
      assetName: name,
      user: owner,
    });
  };

  const onAssetApproved = (assetId: bigint, owner: string, txId: bigint) => {
    const id = txId.toString();
    keyStore.storeKey(id, owner);
    console.log(`[L2] AssetApproved   owner=${owner} assetId=${assetId} txId=${id}`);
  };

  const onAssetTransferred = async (
    assetId: bigint,
    from: string,
    to: string,
    txId: bigint,
  ) => {
    const id = txId.toString();
    // Transfer shares one txId on-chain, but the *working* key belongs to
    // the new owner — they're the one who should control this asset's data
    // going forward, and whose exit should be able to affect it.
    keyStore.storeKey(id, to);
    console.log(`[L2] AssetTransferred assetId=${assetId} from=${from} to=${to} txId=${id}`);
    await rekeyAsset(assetId.toString(), id, keyStore);
  };

  const onKeyDestructionRequested = async (
    user: string,
    assetIds: bigint[],
    dispositionTxIds: bigint[],
    newOwners: string[],
    txIds: bigint[],
  ) => {
    const ids = txIds.map(id => id.toString());
    console.log(`[L2] KeyDestructionRequested user=${user} txIds=[${ids.join(',')}]`);

    // Re-key every disposed-but-transferred asset (TRANSFER_TO_SYSTEM/USER)
    // BEFORE destroying the exiting user's keys below — otherwise the
    // destroy step could blank a key this loop still needs to read from.
    for (let i = 0; i < assetIds.length; i++) {
      if (dispositionTxIds[i] === ethers.MaxUint256) continue; // BURN — nothing to rekey
      const assetId = assetIds[i].toString();
      const newTxId = dispositionTxIds[i].toString();
      const newOwner = newOwners[i];
      keyStore.storeKey(newTxId, newOwner);
      console.log(`[L2] Exit disposition rekey: assetId=${assetId} newOwner=${newOwner} txId=${newTxId}`);
      await rekeyAsset(assetId, newTxId, keyStore);
    }

    await performErasure(user, ids, keyStore, provider, address, abi);
  };

  // Reject's *decision* is on-chain (a permanent, public fact); its
  // *consequence* — destroying whatever keys were already derived for the
  // rejected user/asset — is this L2 reaction, exactly mirroring how RTBF
  // exit's decision (requestExit) vs. consequence (performErasure) already
  // works. destroyKeysForUser/destroyKey are the same "reject = erasure"
  // primitive used everywhere else in this file.
  const onUserRejected = (user: string, timestamp: bigint) => {
    console.log(`[L2] UserRejected user=${user}`);
    const destroyed = keyStore.destroyKeysForUser(user);
    console.log(`[L2] Destroyed ${destroyed.length} key(s) for rejected user=${user}`);
    sseManager.push(user, 'USER_REJECTED', { user, timestamp: timestamp.toString() });
  };

  const onAssetRejected = (assetId: bigint, owner: string, timestamp: bigint) => {
    const id = assetId.toString();
    console.log(`[L2] AssetRejected assetId=${id} owner=${owner}`);
    const txId = keyStore.getAssetTxId(id);
    if (txId) {
      keyStore.destroyKey(txId);
      console.log(`[L2] Destroyed key txId=${txId} for rejected assetId=${id}`);
    }
    sseManager.push(owner, 'ASSET_REJECTED', { assetId: id, owner, timestamp: timestamp.toString() });
  };

  // Mints a key for the new assertion txId — no different from any other
  // txId in this file. The value/price content itself never appears here;
  // it's POSTed separately to L3 once the submitter sees KEY_READY, same
  // two-step pattern as registration PII and asset metadata.
  const onFinancialAssertionRequested = (
    assetId: bigint,
    submittedBy: string,
    counterparty: string,
    txId: bigint,
  ) => {
    const id = txId.toString();
    keyStore.storeKey(id, submittedBy);
    keyStore.createAssertion({
      txId: id,
      assetId: assetId.toString(),
      submittedBy,
      counterparty: counterparty === ethers.ZeroAddress ? null : counterparty,
      status: 'PENDING',
    });
    console.log(`[L2] FinancialAssertionRequested assetId=${assetId} submittedBy=${submittedBy} counterparty=${counterparty} txId=${id}`);
    sseManager.push(submittedBy, 'KEY_READY', {
      txId: id, purpose: 'FINANCIAL_ASSERTION', assetId: assetId.toString(), user: submittedBy,
    });
  };

  // Confirmation is an on-chain transaction (AssetRegistry.confirmFinancialAssertion),
  // not an L2 API call — this just mirrors the resulting state into L2's
  // local view of the row so the Frontend can display it without a
  // separate L1 read. The actual gate (admin can't approve a sale-price
  // assertion until both sides have confirmed) is enforced on-chain.
  const onFinancialAssertionConfirmed = (txId: bigint, confirmedBy: string, bothConfirmed: boolean, timestamp: bigint) => {
    const id = txId.toString();
    keyStore.recordConfirmation(id, confirmedBy);
    console.log(`[L2] FinancialAssertionConfirmed txId=${id} confirmedBy=${confirmedBy} bothConfirmed=${bothConfirmed}`);
  };

  // Admin's governance decision — reject destroys the assertion's key, same
  // "reject = erasure" principle applied uniformly across this whole file.
  const onFinancialAssertionDecided = (txId: bigint, approved: boolean, admin: string, timestamp: bigint) => {
    const id = txId.toString();
    keyStore.decideAssertion(id, approved ? 'APPROVED' : 'REJECTED', admin);
    if (!approved) {
      keyStore.destroyKey(id);
    }
    console.log(`[L2] FinancialAssertionDecided txId=${id} approved=${approved} admin=${admin}`);
  };

  contract.on('UserRegistered', onUserRegistered);
  contract.on('UserApproved', onUserApproved);
  contract.on('UserRejected', onUserRejected);
  contract.on('AssetCreated', onAssetCreated);
  contract.on('AssetApproved', onAssetApproved);
  contract.on('AssetRejected', onAssetRejected);
  contract.on('FinancialAssertionRequested', onFinancialAssertionRequested);
  contract.on('FinancialAssertionConfirmed', onFinancialAssertionConfirmed);
  contract.on('FinancialAssertionDecided', onFinancialAssertionDecided);
  contract.on('AssetTransferred', onAssetTransferred);
  contract.on('KeyDestructionRequested', onKeyDestructionRequested);

  provider.on('error', (err: Error) => {
    console.error('[L2] WebSocket error:', err.message);
  });

  // (1) The raw close event — ethers v6's WebSocketProvider never reconnects
  // on its own (its reconnect-on-close logic is dead code in the library
  // itself), and provider.on('error', ...) above is log-only. Drive
  // reconnection ourselves from the underlying socket's real close event.
  const ws = provider.websocket as any;
  const onSocketClose = () => {
    if (stale) return;
    console.error('[L2] L1 WebSocket closed — reconnecting.');
    onDisconnect();
  };
  ws.on('close', onSocketClose);

  // (2) Active heartbeat — covers the case actually reproduced in practice:
  // the subscription goes silently dead (no 'close', no 'error' event at
  // all) while the socket looks open. Periodically prove the connection is
  // still really working; if it isn't, treat it the same as a close.
  const heartbeat = setInterval(async () => {
    try {
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('heartbeat timed out')), HEARTBEAT_TIMEOUT_MS)),
      ]);
    } catch (err: any) {
      if (stale) return;
      console.error('[L2] L1 connection heartbeat failed — reconnecting:', err.message);
      onDisconnect();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // (3) Forced periodic resubscribe — see FORCED_RESUBSCRIBE_INTERVAL_MS above
  // for why the heartbeat alone can't catch this: it proves the transport is
  // alive, not that the logs subscription is still delivering. This just
  // reuses the same reconnect path on a timer, independent of whether
  // anything above has detected a problem.
  const forcedResubscribe = setInterval(() => {
    if (stale) return;
    console.log('[L2] Periodic forced resubscribe (bounds undetectable logs-subscription staleness).');
    onDisconnect();
  }, FORCED_RESUBSCRIBE_INTERVAL_MS);

  return () => {
    stale = true;
    clearInterval(heartbeat);
    clearInterval(forcedResubscribe);
    ws.removeListener('close', onSocketClose);
    contract.removeAllListeners();
    provider.destroy();
  };
}

export async function startEventListener(keyStore: KeyStore): Promise<void> {
  let teardown: (() => void) | null = null;
  let reconnecting = false;

  const connect = async () => {
    teardown?.(); // clean up any previous connection before (re)connecting
    teardown = null;
    try {
      teardown = await attach(keyStore, scheduleReconnect);
    } catch (err: any) {
      console.error('[L2] Failed to connect to L1, retrying in 5s:', err.message);
      setTimeout(connect, 5000);
    }
  };

  // Shared by both the close handler and the heartbeat — guards against
  // both firing for the same dead connection and scheduling two overlapping
  // reconnects.
  const scheduleReconnect = () => {
    if (reconnecting) return;
    reconnecting = true;
    setTimeout(() => {
      reconnecting = false;
      connect();
    }, 5000);
  };

  await connect();
}
