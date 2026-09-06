import { createHelia, type HeliaLibp2p } from 'helia';
import { unixfs, type UnixFS } from '@helia/unixfs';
import { FsBlockstore } from 'blockstore-fs';
import { FsDatastore } from 'datastore-fs';
import { CID } from 'multiformats/cid';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

let heliaNode: HeliaLibp2p | null = null;
let heliaFs: UnixFS | null = null;

export async function startIpfs(): Promise<void> {
  const blocksPath = join(config.storagePath, 'blocks');
  const datastorePath = join(config.storagePath, 'datastore');
  mkdirSync(blocksPath, { recursive: true });
  mkdirSync(datastorePath, { recursive: true });

  const blockstore = new FsBlockstore(blocksPath);
  const datastore = new FsDatastore(datastorePath);

  heliaNode = await createHelia({ blockstore, datastore });
  heliaFs = unixfs(heliaNode);

  console.log(`[L3] Helia IPFS node started. Storage: ${config.storagePath}`);
}

export async function stopIpfs(): Promise<void> {
  await heliaNode?.stop();
}

// Pins raw bytes to IPFS and returns the CID string.
export async function pinBytes(data: Uint8Array): Promise<string> {
  if (!heliaFs) throw new Error('Helia not initialised');
  const cid = await heliaFs.addBytes(data);
  return cid.toString();
}

// Retrieves bytes from IPFS by CID string.
export async function getBytes(cidStr: string): Promise<Buffer> {
  if (!heliaFs) throw new Error('Helia not initialised');
  const cid = CID.parse(cidStr);
  const chunks: Uint8Array[] = [];
  for await (const chunk of heliaFs.cat(cid)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
