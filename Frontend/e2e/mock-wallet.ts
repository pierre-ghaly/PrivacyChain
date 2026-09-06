import type { Page } from '@playwright/test';

/**
 * Injects a minimal EIP-1193 provider bound to a single Hardhat account,
 * standing in for the MetaMask browser extension (which can't be driven
 * headlessly). Hardhat's own node holds the private keys for its default
 * accounts and signs `eth_sendTransaction` for them directly — so this
 * provider is just a thin proxy to the real local RPC, no client-side
 * signing needed.
 */
export async function installMockWallet(page: Page, account: string, rpcUrl = 'http://127.0.0.1:8545') {
  await page.addInitScript(
    ({ account, rpcUrl }) => {
      const CHAIN_ID_HEX = '0x7a69'; // 31337

      async function rpc(method: string, params: unknown[]) {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        });
        const body = await res.json();
        if (body.error) throw new Error(body.error.message ?? 'RPC error');
        return body.result;
      }

      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

      const provider = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
          if (method === 'eth_chainId') return CHAIN_ID_HEX;
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
          if (method === 'eth_sendTransaction') {
            const tx = { ...(params?.[0] as Record<string, unknown>), from: account };
            return rpc('eth_sendTransaction', [tx]);
          }
          return rpc(method, params ?? []);
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          (listeners[event] ??= []).push(cb);
        },
        removeListener: (event: string, cb: (...args: unknown[]) => void) => {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
        },
      };

      Object.defineProperty(window, 'ethereum', { value: provider, writable: true, configurable: true });

      // EIP-6963 discovery — the standard multi-wallet announcement mechanism.
      // RainbowKit's generic "injected wallet" connector uses this (rather
      // than MetaMask's own SDK handshake), so it's a more reliable target
      // for a mock provider than pretending to literally be the extension.
      const info = {
        uuid: 'e2e-mock-wallet-0000-0000-000000000000',
        name: 'E2E Test Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        rdns: 'dev.privacychain.e2e-test-wallet',
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
        );
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { account, rpcUrl },
  );
}
