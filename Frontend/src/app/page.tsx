'use client';
import { useAccount, useDisconnect, useWriteContract, useReadContract, useSignMessage } from 'wagmi';
import { useState, useEffect, useRef } from 'react';
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { ConnectButton } from '@rainbow-me/rainbowkit';
import RegisterModal, { type RegistrationPii } from '@/components/registermodal';
import { toast } from 'sonner';
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, L2_SERVER_URL } from '@/contracts';
import { getAuthHeader } from '@/lib/l2Auth';

interface KeyReadyPayload {
  txId: string;
  purpose: 'USER_PII' | 'ASSET_METADATA';
  user: string;
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  
  // hook to send registration transaction
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  // fetch user registration status on-chain
  const { data: userStruct, refetch: checkRegistration } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'users',
    args: address ? [address] : undefined,
    query: { enabled: !!address }
  });

  const isRegistered = userStruct ? (userStruct as any)[0] : false;
  
  const [showModal, setShowModal] = useState(false);
  const [mounted, setMounted] = useState(false);
  const wasConnected = useRef(isConnected);
  // PII from the registration form, held in memory until L2 signals the
  // per-transaction key is ready — only then is it sent to L3 for encryption.
  const pendingPii = useRef<RegistrationPii | null>(null);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (isConnected && !wasConnected.current && !isRegistered) {
      setShowModal(true);
    }
    wasConnected.current = isConnected;
  }, [isConnected, isRegistered]);

  // once L2 derives Kr for this registration, push the PII to L3 for encrypted storage
  useEffect(() => {
    const handleKeyReady = async (e: Event) => {
      const { detail } = e as CustomEvent<KeyReadyPayload>;
      if (detail.purpose !== 'USER_PII' || !pendingPii.current) return;
      if (address && detail.user.toLowerCase() !== address.toLowerCase()) return;

      const pii = pendingPii.current;
      pendingPii.current = null;
      try {
        const authHeader = await getAuthHeader(detail.user, signMessageAsync);
        const res = await fetch(`${L2_SERVER_URL}/l3/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({ txId: detail.txId, dataType: 'USER_PII', data: pii }),
        });
        if (!res.ok) throw new Error(`L3 store failed (${res.status})`);
        toast.success("Personal data encrypted and stored off-chain (L3).");
      } catch (err) {
        console.error(err);
        toast.error("Registered on-chain, but storing your personal data on L3 failed.");
      }
    };

    window.addEventListener('L2_KEY_READY', handleKeyReady);
    return () => window.removeEventListener('L2_KEY_READY', handleKeyReady);
  }, [address]);

  // invoke registerUser method on contract, then wait for L2/L3 to store the PII
  const handleRegister = async (pii: RegistrationPii) => {
    const toastId = toast.loading("Sending registration request to blockchain...");
    try {
      pendingPii.current = pii;
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'registerUser',
      });

      toast.success("Transaction sent! Pending block confirmation...", { id: toastId });
      setShowModal(false);

      // refresh user state after block interval
      setTimeout(() => {
        checkRegistration();
        toast.info("Registration request saved on-chain. Awaiting Admin approval.");
      }, 3000);

    } catch (error: any) {
      pendingPii.current = null;
      console.error(error);
      toast.error(error.shortMessage || "Transaction rejected or failed.", { id: toastId });
    }
  };

  const handleCancel = () => {
    setShowModal(false);
    disconnect(); 
  };
  
  return (
    <main className="max-w-7xl mx-auto px-8 py-20">
      {mounted && isConnected && !isRegistered && showModal && (
        <RegisterModal 
          address={address as string} 
          onSign={handleRegister} 
          onClose={handleCancel} 
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
        <div className="flex flex-col items-start text-left pt-10">
          <Badge text="GDPR-Compliant Protocol" />
          <h1 className="text-6xl font-bold mt-8 mb-6 tracking-tight leading-[1.1] text-black">
            Privacy-preserving<br />asset tokenization
          </h1>
          <p className="text-gray-500 max-w-md text-lg font-medium leading-relaxed mb-10">
            Connect your wallet to manage assets, transfer ownership, update on-chain settings, and execute GDPR-compliant exit flows through cryptographic erasure.
          </p>
          <ConnectButton />
        </div>

        <div className="space-y-6">
          <Card className="bg-gray-50/50">
             <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold">System architecture</h2>
                <Badge text="Triple-layer" />
             </div>
             <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white p-4 rounded-xl border border-gray-100">
                  <p className="text-[10px] uppercase font-bold text-gray-400 mb-1">Layer 1</p>
                  <h4 className="font-bold text-sm mb-2 text-black">On-chain</h4>
                  <p className="text-xs text-gray-500 leading-snug">Contracts, logs, public verification.</p>
                </div>
                <div className="bg-white p-4 rounded-xl border border-gray-100">
                  <p className="text-[10px] uppercase font-bold text-gray-400 mb-1">Layer 2</p>
                  <h4 className="font-bold text-sm mb-2 text-black">Key storage</h4>
                  <p className="text-xs text-gray-500 leading-snug">Reference keys, sessions, erasure.</p>
                </div>
                <div className="bg-white p-4 rounded-xl border border-gray-100">
                  <p className="text-[10px] uppercase font-bold text-gray-400 mb-1">Layer 3</p>
                  <h4 className="font-bold text-sm mb-2 text-black">Encrypted data</h4>
                  <p className="text-xs text-gray-500 leading-snug">IPFS decentralized storage.</p>
                </div>
             </div>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="p-5">
              <h4 className="font-bold text-sm mb-2">Wallet-first identity</h4>
              <p className="text-xs text-gray-500">Address = Identity.</p>
            </Card>
            <Card className="p-5">
              <h4 className="font-bold text-sm mb-2">Signed actions</h4>
              <p className="text-xs text-gray-500">Requires explicit user approval.</p>
            </Card>
            <Card className="p-5">
              <h4 className="font-bold text-sm mb-2">RTBF compliance</h4>
              <p className="text-xs text-gray-500">Cryptographic key destruction.</p>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}