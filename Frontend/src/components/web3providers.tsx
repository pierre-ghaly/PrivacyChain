'use client';
import '@rainbow-me/rainbowkit/styles.css';
import { WagmiProvider, useAccount } from 'wagmi';
import { mainnet, sepolia, hardhat } from 'wagmi/chains';
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { getDefaultConfig, RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { L2_SERVER_URL } from '@/contracts';

const config = getDefaultConfig({
  appName: 'Blockchain App',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'PROJECT_ID',
  chains: [hardhat, sepolia, mainnet],
  ssr: true,
});

const queryClient = new QueryClient();

function L2EventListener({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();

  useEffect(() => {
    if (!isConnected || !address) return;

    const url = `${L2_SERVER_URL}/events?user=${address.toLowerCase()}`;

    const source = new EventSource(url);

    source.addEventListener('KEY_READY', (e) => {
      try {
        const payload = JSON.parse(e.data);
        const event = new CustomEvent('L2_KEY_READY', { detail: payload });
        window.dispatchEvent(event);
      } catch (err) {
        console.error('[L2 SSE] Error parsing KEY_READY data', err);
      }
    });

    source.addEventListener('ERASURE_COMPLETE', (e) => {
      try {
        const payload = JSON.parse(e.data);

        toast.success("Exit complete: Your personal data has been cryptographically destroyed on-chain.", {
          duration: 10000,
        });

        const event = new CustomEvent('L2_ERASURE_COMPLETE', { detail: payload });
        window.dispatchEvent(event);
      } catch (err) {
        console.error('[L2 SSE] Error parsing ERASURE_COMPLETE data', err);
      }
    });

    source.onerror = () => {
      console.warn('[L2 SSE] Connection error. Retrying...');
    };

    return () => {
      source.close();
    };
  }, [address, isConnected]);

  return <>{children}</>;
}

export function Web3Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider 
          locale="en-US"
          theme={lightTheme({
            accentColor: '#111111', 
            accentColorForeground: 'white',
            borderRadius: 'large', 
          })}
        >
          <L2EventListener>
            {children}
          </L2EventListener>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}