import { Router } from 'express';
import type { KeyStore } from '../keyStore';

export function statusRouter(keyStore: KeyStore): Router {
  const router = Router();

  // GET /status/:user
  // Returns erasure status for a user: how many keys exist, how many destroyed.
  router.get('/:user', (req, res) => {
    const user = req.params.user.toLowerCase();
    const allTxIds = keyStore.getUserTxIds(user);
    const destroyedTxIds = keyStore.getDestroyedTxIds(user);

    res.json({
      user,
      totalKeys: allTxIds.length,
      destroyedKeys: destroyedTxIds.length,
      activeKeys: allTxIds.length - destroyedTxIds.length,
      erasureComplete: allTxIds.length > 0 && destroyedTxIds.length === allTxIds.length,
    });
  });

  return router;
}
