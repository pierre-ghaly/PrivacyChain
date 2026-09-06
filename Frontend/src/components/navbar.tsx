'use client';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useReadContract } from 'wagmi';
import { useEffect, useState } from 'react';
import { keccak256, toHex } from 'viem';
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI } from '@/contracts';

const ADMIN_ROLE_HASH = keccak256(toHex("ADMIN_ROLE")) as `0x${string}`;

export default function Navbar() {
  const { address, isConnected } = useAccount();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Same on-chain hasRole(ADMIN_ROLE, ...) check every admin page itself
  // uses — a hardcoded address comparison here would silently exclude any
  // second address the role gets granted to.
  const { data: isAdminRole } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'hasRole',
    args: address ? [ADMIN_ROLE_HASH, address] : undefined,
    query: { enabled: mounted && isConnected && !!address }
  });

  // Only evaluate wallet state after client mount to avoid SSR/client mismatch
  const isAdmin = mounted && isConnected && !!address && !!isAdminRole;

  return (
    <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-100 bg-white">
      <div className="flex items-center gap-12">
        <Link href="/" className="text-xl font-semibold tracking-tight text-black">
          blockchain<span className="text-gray-400">.</span>
        </Link>

        {mounted && isConnected && (
          <div className="hidden md:flex items-center gap-8">
            <Link 
              href="/dashboard" 
              className={`text-sm font-medium transition-colors ${pathname === '/dashboard' ? 'text-black' : 'text-gray-400 hover:text-black'}`}
            >
              My Assets
            </Link>
            <Link 
              href="/dashboard/transfers" 
              className={`text-sm font-medium transition-colors ${pathname === '/dashboard/transfers' ? 'text-black' : 'text-gray-400 hover:text-black'}`}
            >
              Transfers
            </Link>
            <Link 
              href="/dashboard/settings" 
              className={`text-sm font-medium transition-colors ${pathname === '/dashboard/settings' ? 'text-black' : 'text-gray-400 hover:text-black'}`}
            >
              Settings
            </Link>
            
            {isAdmin && (
            <Link 
              href="/dashboard/explorer" 
              className={`text-sm font-medium transition-colors ${pathname === '/dashboard/explorer' ? 'text-black' : 'text-gray-400 hover:text-black'}`}
            >
              Explorer
            </Link>
            )}

            {isAdmin && (
              <Link 
                href="/admin" 
                className={`text-sm font-bold transition-colors ${pathname === '/admin' ? 'text-red-600' : 'text-red-400 hover:text-red-600'}`}
              >
                Admin Panel
              </Link>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-6">
        {mounted && isConnected && isAdmin && (
          <Link 
            href="/admin/create" 
            className="text-xs font-bold text-black border border-black px-3 py-1.5 rounded-md hover:bg-black hover:text-white transition-all"
          >
            + Mint New Asset
          </Link>
        )}
        
        <ConnectButton showBalance={false} chainStatus="none" />
      </div>
    </nav>
  );
}