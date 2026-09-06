import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';

interface EncryptedBlob {
  iv: string;
  ciphertext: string;
  authTag: string;
}

// Encrypts arbitrary bytes with AES-256-GCM using a 32-byte key.
// Returns a JSON envelope that L3 pins to IPFS.
export function encryptData(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    authTag: authTag.toString('hex'),
  };
  return Buffer.from(JSON.stringify(blob), 'utf8');
}

// Decrypts an AES-256-GCM envelope. Throws if the key is wrong or data is tampered.
export function decryptData(encryptedBuf: Buffer, key: Buffer): Buffer {
  const { iv, ciphertext, authTag } = JSON.parse(
    encryptedBuf.toString('utf8'),
  ) as EncryptedBlob;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
}
