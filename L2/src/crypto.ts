import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';
import { config } from './config';

// A fresh 32-byte secret generated once per transaction, at first key derivation.
// It is required input to deriveKr and is never re-derivable from anything else —
// storeKey persists it alongside Kr, and destroyKeysForUser deletes it outright.
// This is what makes "destroyed" mean cryptographically unrecoverable rather than
// just access-gated: masterSalt and txId alone are no longer sufficient to
// reconstruct Kr once the nonce backing it is gone.
export function generateNonce(): Buffer {
  return randomBytes(32);
}

// HKDF-Extract + HKDF-Expand (RFC 5869, one round, SHA-256)
// ikm = txId || nonce, per the per-transaction key scheme documented in
// AssetRegistry.sol's NatSpec (Kr = HKDF(salt, transactionId || nonce)).
export function deriveKr(txId: string, nonce: Buffer): Buffer {
  const salt = Buffer.from(config.masterSalt, 'utf8');
  const ikm = Buffer.concat([Buffer.from(txId, 'utf8'), nonce]);
  // Extract
  const prk = createHmac('sha256', salt).update(ikm).digest();
  // Expand with context label
  const info = Buffer.from('PrivacyChain-Kr-v1', 'utf8');
  const okm = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return okm; // 32 bytes → AES-256 key
}

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  authTag: string;
}

export function encryptBuffer(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    authTag: authTag.toString('hex'),
  };
  return JSON.stringify(blob);
}

export function decryptBuffer(encryptedJson: string, key: Buffer): Buffer {
  const { iv, ciphertext, authTag } = JSON.parse(encryptedJson) as EncryptedBlob;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
}

// SHA-256 commitment: proofHash = SHA-256(user || sorted(txIds).join(',') || timestamp)
export function computeErasureProofHash(
  user: string,
  txIds: string[],
  timestamp: number,
): Buffer {
  const input = `${user.toLowerCase()}|${[...txIds].sort().join(',')}|${timestamp}`;
  return createHash('sha256').update(input, 'utf8').digest();
}
