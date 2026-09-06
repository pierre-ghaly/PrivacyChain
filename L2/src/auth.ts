import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

declare global {
  namespace Express {
    interface Request {
      authAddress?: string;
    }
  }
}

interface Session {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

// In-memory only — a demo restart just means the Frontend re-signs, which
// the client-side lazy-auth flow already handles transparently.
const sessions = new Map<string, Session>();

function buildMessage(address: string, session: Session): string {
  return [
    'PrivacyChain wants you to sign in with your Ethereum account:',
    address,
    '',
    'Authorize this session to access your encrypted data.',
    '',
    `Nonce: ${session.nonce}`,
    `Issued At: ${new Date(session.issuedAt).toISOString()}`,
    `Expires At: ${new Date(session.expiresAt).toISOString()}`,
  ].join('\n');
}

// Issues a fresh nonce for an address, overwriting any previous session —
// only the most-recently-issued nonce's signature will ever verify.
export function issueNonce(address: string): { message: string; expiresAt: number } {
  const lower = address.toLowerCase();
  const issuedAt = Date.now();
  const session: Session = {
    nonce: randomBytes(16).toString('hex'),
    issuedAt,
    expiresAt: issuedAt + config.authSessionTtlMs,
  };
  sessions.set(lower, session);
  return { message: buildMessage(address, session), expiresAt: session.expiresAt };
}

// Never trusts a client-supplied message — rebuilds the expected string
// server-side from the session L2 itself issued, so tampering with the
// address, nonce, or timestamps just fails to recover a matching signer.
export function verifySignature(address: string, signature: string): boolean {
  const lower = address.toLowerCase();
  const session = sessions.get(lower);
  if (!session) return false;
  if (Date.now() > session.expiresAt) return false;

  const expected = buildMessage(address, session);
  try {
    const recovered = ethers.verifyMessage(expected, signature);
    return recovered.toLowerCase() === lower;
  } catch {
    return false;
  }
}

// Authorization header shape: "<address> <signature>" — neither value can
// contain a space, so this needs no new CORS-exposed header beyond the
// Authorization header L2 already allows.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ error: 'Authorization header required.' });
    return;
  }
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) {
    res.status(401).json({ error: 'Malformed Authorization header.' });
    return;
  }
  const address = header.slice(0, spaceIndex);
  const signature = header.slice(spaceIndex + 1);

  if (!ethers.isAddress(address) || !verifySignature(address, signature)) {
    res.status(401).json({ error: 'Signature verification failed — sign in again.' });
    return;
  }

  req.authAddress = address.toLowerCase();
  next();
}
