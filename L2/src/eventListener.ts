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

async function attach(keyStore: KeyStore): Promise<() => void> {
  const { address, abi } = loadDeployment();
  const provider = new ethers.WebSocketProvider(config.l1WsUrl);

  // Verify the connection is live before setting up listeners.
  // getNetwork() will throw (and be caught by the retry loop) if Hardhat is unreachable.
  await provider.getNetwork();

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

  contract.on('UserRegistered', onUserRegistered);
  contract.on('UserApproved', onUserApproved);
  contract.on('AssetCreated', onAssetCreated);
  contract.on('AssetApproved', onAssetApproved);
  contract.on('AssetTransferred', onAssetTransferred);
  contract.on('KeyDestructionRequested', onKeyDestructionRequested);

  provider.on('error', (err: Error) => {
    console.error('[L2] WebSocket error:', err.message);
  });

  return () => {
    contract.removeAllListeners();
    provider.destroy();
  };
}

export async function startEventListener(keyStore: KeyStore): Promise<void> {
  let teardown: (() => void) | null = null;

  const connect = async () => {
    teardown?.(); // clean up any previous connection before retrying
    try {
      teardown = await attach(keyStore);
    } catch (err: any) {
      console.error('[L2] Failed to connect to L1, retrying in 5s:', err.message);
      teardown = null;
      setTimeout(connect, 5000);
    }
  };

  await connect();
}
