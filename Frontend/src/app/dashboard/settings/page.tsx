'use client';
import { Card } from "@/components/card";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { isAddress } from "viem";
import { useReadContract, useWriteContract, useAccount, useSignMessage } from "wagmi";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, L2_SERVER_URL } from "@/contracts";
import { getAuthHeader } from "@/lib/l2Auth";

export default function SettingsPage() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  
  const [confirmAddress, setConfirmAddress] = useState("");
  
  const [assetsPublic, setAssetsPublic] = useState(false);
  const [transactionsPublic, setTransactionsPublic] = useState(false);
  const [inactivePolicy, setInactivePolicy] = useState(0); 
  const [beneficiary, setBeneficiary] = useState("");

  // read current user configuration from contract
  const { data: userConfig, refetch: refetchConfig } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getMyConfig',
    account: address,
    query: {
      enabled: !!address,
      staleTime: 0
    }
  });

  // exitTimestamp > 0 is the only reliable "already exited" signal — see
  // dashboard/page.tsx and admin/page.tsx for the same pattern.
  const { data: exitStatusData, refetch: refetchExitStatus } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getExitStatus',
    args: address ? [address] : undefined,
    query: { enabled: !!address }
  });
  const hasExited = exitStatusData ? (exitStatusData as [boolean, bigint, boolean])[1] > 0n : false;

  const [myPii, setMyPii] = useState<{ realName: string; email: string; address?: string } | null>(null);
  const [piiStatus, setPiiStatus] = useState<'loading' | 'found' | 'erased' | 'not_stored'>('loading');

  // registerUser() is necessarily a user's first-ever transaction, so the
  // first entry in their (append-only) transaction list is the registration txId.
  const { data: myTxIds } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getUserTransactions',
    args: address ? [address] : undefined,
    query: { enabled: !!address }
  });

  useEffect(() => {
    const txIds = myTxIds as bigint[] | undefined;
    if (!txIds || txIds.length === 0 || !address) return;
    const registrationTxId = txIds[0].toString();

    (async () => {
      setPiiStatus('loading');
      try {
        const authHeader = await getAuthHeader(address, signMessageAsync);
        const dataRes = await fetch(`${L2_SERVER_URL}/l3/data/${registrationTxId}?dataType=USER_PII`, {
          headers: { 'Authorization': authHeader },
        });
        if (dataRes.status === 410) {
          setPiiStatus('erased');
          return;
        }
        if (!dataRes.ok) {
          setPiiStatus('not_stored');
          return;
        }
        const { data } = await dataRes.json();
        setMyPii(data);
        setPiiStatus('found');
      } catch {
        setPiiStatus('not_stored');
      }
    })();
  }, [myTxIds, address, signMessageAsync]);

  const { data: erasureProof } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getErasureProof',
    args: address ? [address] : undefined,
    query: { enabled: hasExited }
  });

  // sync contract state with local react state
  useEffect(() => {
    if (userConfig) {
      const config = userConfig as any;
      
      const onChainAssetsPublic = config.assetsPublic ?? config[0] ?? false;
      const onChainTxPublic = config.transactionsPublic ?? config[1] ?? false;
      const onChainPolicy = config.inactivePolicy ?? config[2] ?? 0;
      const onChainBeneficiary = config.inactiveBeneficiary ?? config[3] ?? "";

      setAssetsPublic(onChainAssetsPublic);
      setTransactionsPublic(onChainTxPublic);
      setInactivePolicy(Number(onChainPolicy));
      
      if (onChainBeneficiary && onChainBeneficiary !== "0x0000000000000000000000000000000000000000") {
        setBeneficiary(onChainBeneficiary);
      } else if (Number(onChainPolicy) !== 1) {
        setBeneficiary("");
      }
    }
  }, [userConfig]);

  // update privacy preferences on-chain
  const handleSaveVisibility = async () => {
    const toastId = toast.loading("Updating privacy settings on-chain...");
    try {
      const tx = await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'setVisibility',
        args: [assetsPublic, transactionsPublic],
      });
      toast.success("Privacy preferences updated!", { id: toastId });
      setTimeout(() => {
        refetchConfig();
      }, 2000);
    } catch (error: any) {
      toast.error(error.shortMessage || "Transaction failed", { id: toastId });
    }
  };

  // update inheritance backup rules on-chain
  const handleSavePolicy = async () => {
    if (inactivePolicy === 1 && !isAddress(beneficiary)) {
      toast.error("Please enter a valid beneficiary wallet address");
      return;
    }

    const toastId = toast.loading("Securing inheritance policy...");
    try {
      const targetBeneficiary = inactivePolicy === 1 ? beneficiary : "0x0000000000000000000000000000000000000000";
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'setInactivePolicy',
        args: [inactivePolicy, targetBeneficiary],
      });
      toast.success("Inheritance policy anchored!", { id: toastId });
      setTimeout(() => {
        refetchConfig();
      }, 2000);
    } catch (error: any) {
      toast.error(error.shortMessage || "Transaction failed", { id: toastId });
    }
  };

  // request RTBF account exit protocol
  const handleExit = async () => {
    if (!isAddress(confirmAddress)) {
      toast.error("Please enter a valid wallet address");
      return;
    }
    
    if (confirmAddress.toLowerCase() !== address?.toLowerCase()) {
      toast.error("The address entered does not match your connected wallet");
      return;
    }

    const toastId = toast.loading('Initiating On-chain Exit Protocol...');
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'requestExit',
      });
      toast.success('Exit requested. Your cryptographic keys are being destroyed and the erasure proof anchored automatically.', { id: toastId });
      setConfirmAddress("");
      setTimeout(() => {
        refetchExitStatus();
      }, 2000);
    } catch (error: any) {
      toast.error(error.shortMessage || 'Exit protocol transaction aborted.', { id: toastId });
    }
  };

  return (
    <section className="max-w-4xl mx-auto p-8 space-y-10">
      <div>
        <h1 className="text-4xl font-bold text-black tracking-tight">Settings</h1>
        <p className="text-gray-500 mt-1">Manage your privacy ledger parameters and assets safety.</p>
      </div>

      {/* my registered information — this session's view of own submitted PII */}
      <Card className="p-6 border-gray-100">
        <h2 className="text-black font-bold text-lg mb-1">My Registered Information</h2>
        <p className="text-xs text-gray-400 mb-6">The PII you submitted at registration, decrypted from Layer 3.</p>

        {piiStatus === 'loading' && (
          <div className="h-16 bg-gray-50 rounded-xl animate-pulse" />
        )}
        {piiStatus === 'found' && myPii && (
          <div className="space-y-2">
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Full Name</span>
              <span className="text-sm text-black font-semibold">{myPii.realName}</span>
            </div>
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Email</span>
              <span className="text-sm text-black font-semibold">{myPii.email}</span>
            </div>
            {myPii.address && (
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Address</span>
                <span className="text-sm text-black font-semibold">{myPii.address}</span>
              </div>
            )}
          </div>
        )}
        {piiStatus === 'erased' && (
          <p className="text-xs text-gray-400 italic bg-gray-50 rounded-xl p-4 border border-dashed">
            Your registration data has been cryptographically erased following an RTBF exit.
          </p>
        )}
        {piiStatus === 'not_stored' && (
          <p className="text-xs text-gray-400 italic bg-gray-50 rounded-xl p-4 border border-dashed">
            No PII on record for this session (e.g. a seeded account with no real registration flow).
          </p>
        )}
      </Card>

      {/* privacy settings container */}
      <Card className="p-6 border-gray-100">
        <h2 className="text-black font-bold text-lg mb-1">Privacy Preferences</h2>
        <p className="text-xs text-gray-400 mb-6">Control what data is visible to other nodes on the registry.</p>
        
        <div className="space-y-4 mb-6">
          <label className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 cursor-pointer">
            <div>
              <span className="text-sm font-bold block text-black">Public Assets Ledger</span>
              <span className="text-xs text-gray-400">Allow other users to see the RWA tokens you own.</span>
            </div>
            <input 
              type="checkbox" 
              className="w-4 h-4 accent-black rounded" 
              checked={assetsPublic}
              onChange={(e) => setAssetsPublic(e.target.checked)}
            />
          </label>

          <label className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100 cursor-pointer">
            <div>
              <span className="text-sm font-bold block text-black">Public Transaction History</span>
              <span className="text-xs text-gray-400">Make your transfers and operations metadata visible.</span>
            </div>
            <input 
              type="checkbox" 
              className="w-4 h-4 accent-black rounded"
              checked={transactionsPublic}
              onChange={(e) => setTransactionsPublic(e.target.checked)}
            />
          </label>
        </div>

        <div className="flex justify-end">
          <button 
            onClick={handleSaveVisibility}
            className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 transition-all"
          >
            Save Privacy Rules
          </button>
        </div>
      </Card>

      {/* inheritance rule container */}
      <Card className="p-6 border-gray-100">
        <h2 className="text-black font-bold text-lg mb-1">Asset Inheritance & Succession</h2>
        <p className="text-xs text-gray-400 mb-6">Define backup policies if your account becomes inactive or loses its private key access.</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-gray-600">Inactive Policy</label>
            <select 
              className="p-3 rounded-xl border border-gray-200 bg-white text-sm outline-none focus:border-black"
              value={inactivePolicy}
              onChange={(e) => setInactivePolicy(Number(e.target.value))}
            >
              <option value={0}>0 - Transfer to System (Platform Custody)</option>
              <option value={1}>1 - Auto-Transfer to Beneficiary</option>
              <option value={2}>2 - Burn Asset (Permanent Erasure)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-gray-600">Beneficiary Address</label>
            <input 
              type="text" 
              placeholder="0x..."
              disabled={inactivePolicy !== 1}
              className="p-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-black disabled:bg-gray-50 disabled:text-gray-400"
              value={beneficiary}
              onChange={(e) => setBeneficiary(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button 
            onClick={handleSavePolicy}
            className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 transition-all"
          >
            Update Backup Policy
          </button>
        </div>
      </Card>

      {/* danger zone container */}
      <Card className="border-red-100 bg-red-50/10 p-8 border-2 rounded-2xl">
        <h2 className="text-red-600 font-bold text-xl mb-1">Danger Zone</h2>
        <p className="text-xs text-red-400 mb-5">Account Deactivation & Erasure Protocols</p>
        {hasExited ? (
          <div>
            <p className="text-gray-600 text-sm leading-relaxed mb-4">
              Your account has already exited via the RTBF protocol. Your cryptographic keys were
              destroyed and the erasure proof anchored automatically — there is nothing further to do.
            </p>
            {(() => {
              const proofHash = erasureProof as string | undefined;
              if (!proofHash || proofHash === `0x${'0'.repeat(64)}`) return null;
              return (
                <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                  <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Recorded Erasure Proof (on-chain)</span>
                  <span className="text-[11px] font-mono break-all text-black">{proofHash}</span>
                </div>
              );
            })()}
          </div>
        ) : (
          <>
            <p className="text-gray-600 text-sm mb-6 leading-relaxed">
              The Exit Protocol will signal the ledger that you wish to deactivate your user status.
              Your cryptographic keys will be destroyed and an erasure proof anchored automatically. This operation anchors an irreversible state change.
            </p>

            <div className="flex flex-col gap-4">
              <input
                type="text"
                placeholder="Confirm by typing your wallet address"
                className="p-3 rounded-xl border border-red-200 outline-none focus:ring-2 focus:ring-red-500 bg-white text-sm"
                value={confirmAddress}
                onChange={(e) => setConfirmAddress(e.target.value)}
              />
              <button
                onClick={handleExit}
                className="bg-red-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-red-700 shadow-md shadow-red-600/10 transition-all text-sm"
              >
                Initiate On-Chain Exit Protocol
              </button>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}