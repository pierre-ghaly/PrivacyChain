import { Router } from 'express';
import { ethers } from 'ethers';
import { issueNonce } from '../auth';

export function authRouter(): Router {
  const router = Router();

  // GET /auth/nonce?address=0x...
  // Issues a fresh session for the address and returns the exact message the
  // Frontend must sign verbatim — the Frontend never constructs this string
  // itself, so there's no risk of client/server drift.
  router.get('/nonce', (req, res) => {
    const address = req.query.address as string | undefined;
    if (!address || !ethers.isAddress(address)) {
      res.status(400).json({ error: 'A valid address query param is required.' });
      return;
    }
    const { message, expiresAt } = issueNonce(address);
    res.json({ message, expiresAt });
  });

  return router;
}
