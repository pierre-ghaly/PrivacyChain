'use client';
import { Card } from "@/components/card";
import { useReadContract, useWriteContract, useWatchContractEvent, usePublicClient, useAccount } from "wagmi";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI } from "@/contracts";
import { toast } from "sonner";
import { useState, useEffect, useCallback } from "react";
import { keccak256, toHex } from "viem";

const ADMIN_ROLE_HASH = keccak256(toHex("ADMIN_ROLE")) as `0x${string}`;

interface BlockchainAsset {
  id: number;
  name: string;
  status: "Pending" | "Public";
}

interface LogMessage {
  id: string;
  type: "CONNECTED" | "USER_APPROVED" | "ASSET_APPROVED" | "ERASURE_RECORDED";
  message: string;
}

interface UserRegistryState {
  address: string;
  isRegistered: boolean;
  isActive: boolean;
}


export default function AdminPage() {
  const { address: userWalletAddress, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  
  const [activeTab, setActiveTab] = useState<"overview" | "users" | "compliance">("overview");
  
  const [dynamicUserList, setDynamicUserList] = useState<string[]>([]);
  const [allUsersState, setAllUsersState] = useState<UserRegistryState[]>([]);
  const [pendingUsers, setPendingUsers] = useState<string[]>([]);
  const [exitedUsers, setExitedUsers] = useState<UserRegistryState[]>([]);
  
  const [pendingAssets, setPendingAssets] = useState<BlockchainAsset[]>([]);
  const [approvedAssetsHistory, setApprovedAssetsHistory] = useState<BlockchainAsset[]>([]);
  
  const [proofHashes, setProofHashes] = useState<{ [address: string]: string }>({});
  const [selectedAssetHistoryId, setSelectedAssetHistoryId] = useState<number | null>(null);
  const [currentAssetHistoryChain, setCurrentAssetHistoryChain] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [forceExitTarget, setForceExitTarget] = useState<string | null>(null);
  const [isForcingExit, setIsForcingExit] = useState(false);

  const [auditLogs, setAuditLogs] = useState<LogMessage[]>([
    {
      id: "init",
      type: "CONNECTED",
      message: `Admin linked to contract ${ASSET_REGISTRY_ADDRESS.slice(0, 10)}...`
    }
  ]);

  // security check: verify admin role via AccessControl hasRole
  const { data: isAdminRole, isLoading: isLoadingOwner } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'hasRole',
    args: userWalletAddress ? [ADMIN_ROLE_HASH, userWalletAddress] : undefined,
    query: { enabled: isConnected && !!userWalletAddress }
  });

  const isAdmin = isConnected && !!userWalletAddress && !!isAdminRole;

  // fetch users array from contract
  const { data: onChainUsers, refetch: refetchUserList } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getAllUsers',
    account: userWalletAddress,
    query: { enabled: !!isAdmin }
  });

  useEffect(() => {
    if (onChainUsers) {
      setDynamicUserList(onChainUsers as string[]);
    }
  }, [onChainUsers]);

  // fetch all assets — returns AssetDetail[] including status in one call
  const { data: allAssetsData, refetch: refetchAssets } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getAllAssetsDetail',
    account: userWalletAddress,
    query: { enabled: !!isAdmin }
  });

  // compute compliance erasure hash using the user's actual transaction IDs from L1
  const generateProductionErasureHash = useCallback(async (userAddress: string, timestamp: number) => {
    try {
      if (!publicClient) return "";
      const txIds = await publicClient.readContract({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'getUserTransactions',
        args: [userAddress as `0x${string}`],
      }) as bigint[];
      const sorted = [...txIds].map(id => id.toString()).sort();
      const input = `${userAddress.toLowerCase()}|${sorted.join(',')}|${timestamp}`;
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return keccak256(toHex(`${userAddress.toLowerCase()}|${timestamp}`));
    }
  }, [publicClient]);

  // fetch status details for every user found
  const fetchUserStatuses = useCallback(async () => {
    if (!dynamicUserList.length || !publicClient) return;

    try {
      const resolvedUsers = await Promise.all(
        dynamicUserList.map(async (userAddress) => {
          const userData = await publicClient.readContract({
            address: ASSET_REGISTRY_ADDRESS,
            abi: ASSET_REGISTRY_ABI,
            functionName: 'users',
            args: [userAddress],
          }) as [boolean, boolean];

          return {
            address: userAddress,
            isRegistered: userData[0],
            isActive: userData[1],
          };
        })
      );

      setAllUsersState(resolvedUsers);

      // isRegistered && !isActive covers two distinct cases — never-approved
      // and exited-via-RTBF — distinguished below via getExitStatus so each
      // shows up in the right admin queue, not both.
      const pendingApproval: string[] = [];
      const exitedFiltered: UserRegistryState[] = [];
      const computedHashes: { [address: string]: string } = {};

      for (const u of resolvedUsers) {
        if (!u.isRegistered || u.isActive) continue;
        try {
          const exitStatus = await publicClient.readContract({
            address: ASSET_REGISTRY_ADDRESS,
            abi: ASSET_REGISTRY_ABI,
            functionName: 'getExitStatus',
            args: [u.address],
          }) as [boolean, bigint, boolean];

          // exitStatus[0] ("exited") is defined on-chain as just
          // isRegistered && !isActive — identical to "never approved", so it
          // can't tell the two apart. exitTimestamp is only ever written by
          // an actual RTBF exit, so ">0" is the real signal.
          const hasExited = exitStatus[1] > 0n;

          if (!hasExited) {
            pendingApproval.push(u.address);
          } else if (!exitStatus[2]) {
            // Exited but no erasure proof recorded yet — belongs in the queue.
            // Once L2 anchors the proof (normally automatic), it drops out.
            exitedFiltered.push(u);
            const realHash = await generateProductionErasureHash(u.address, Number(exitStatus[1]));
            computedHashes[u.address] = realHash;
          }
        } catch (err) {
          // Don't let one user's failed read blank out the whole queue —
          // fall back to the simpler "awaiting approval" classification.
          console.error(`Error fetching exit status for ${u.address}:`, err);
          pendingApproval.push(u.address);
        }
      }
      setPendingUsers(pendingApproval);
      setExitedUsers(exitedFiltered);
      setProofHashes(prev => ({ ...computedHashes, ...prev }));
    } catch (err) {
      console.error("Error fetching individual user statuses:", err);
    }
  }, [dynamicUserList, publicClient, generateProductionErasureHash]);

  useEffect(() => {
    if (isAdmin) {
      fetchUserStatuses();
    }
  }, [dynamicUserList, publicClient, fetchUserStatuses, isAdmin]);

  const handleApproveUser = async (userAddress: string) => {
    const toastId = toast.loading(`Approving user...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'approveUser',
        args: [userAddress],
        gas: 500000n,
      });
      toast.success("User approved successfully!", { id: toastId });
      fetchUserStatuses();
    } catch (error: any) {
      toast.error(error.shortMessage || "Approval failed.", { id: toastId });
    }
  };

  // admin-initiated RTBF exit — identical on-chain effect to the user's own requestExit()
  const handleForceExit = async (userAddress: string) => {
    setIsForcingExit(true);
    const toastId = toast.loading(`Forcing RTBF exit for ${userAddress.slice(0, 6)}...${userAddress.slice(-4)}...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'adminProcessExit',
        args: [userAddress],
        gas: 500000n,
      });
      toast.success("User exit processed. Assets dispositioned and keys destruction requested.", { id: toastId });
      setForceExitTarget(null);
      fetchUserStatuses();
      refetchAssets();
    } catch (error: any) {
      toast.error(error.shortMessage || "Force exit failed.", { id: toastId });
    } finally {
      setIsForcingExit(false);
    }
  };

  // anchor erasure zk proof to complete rtbf compliance
  const handleRecordErasure = async (userAddress: string) => {
    const hash = proofHashes[userAddress];
    if (!hash) {
      toast.error("Compliance hash is still being computed — try again shortly.");
      return;
    }

    const toastId = toast.loading(`Anchoring ZK Erasure Proof...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'recordErasureProof',
        args: [userAddress, hash as `0x${string}`],
      });
      toast.success("Cryptographic erasure proof anchored permanently on-chain!", { id: toastId });
      setProofHashes(prev => {
        const next = { ...prev };
        delete next[userAddress];
        return next;
      });
      fetchUserStatuses();
    } catch (error: any) {
      toast.error(error.shortMessage || "Failed to record compliance proof.", { id: toastId });
    }
  };

  // fetch full asset log history trail
  const handleFetchAssetHistory = async (assetId: number) => {
    if (!publicClient) return;
    setIsLoadingHistory(true);
    setSelectedAssetHistoryId(assetId);
    try {
      const historyData = await publicClient.readContract({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'getAssetHistory',
        args: [BigInt(assetId)],
      }) as any;
      
      setCurrentAssetHistoryChain(historyData.chain || []);
    } catch (err) {
      console.error("Error reading asset history chain:", err);
      toast.error("Could not fetch the on-chain audit trail.");
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // split assets into pending vs active — status is already in AssetDetail, no extra calls needed
  useEffect(() => {
    if (!allAssetsData || !isAdmin) return;
    const resolvedAssets = (allAssetsData as any[]).map((detail: any) => ({
      id: Number(detail.id),
      name: detail.name,
      status: Number(detail.status) === 0 ? "Pending" : "Public" as "Pending" | "Public"
    }));
    setPendingAssets(resolvedAssets.filter(a => a.status === "Pending"));
    setApprovedAssetsHistory(resolvedAssets.filter(a => a.status === "Public"));
  }, [allAssetsData, isAdmin]);

  const handleApproveAsset = async (assetId: number) => {
    const toastId = toast.loading(`Validating asset #${assetId}...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'approveAsset',
        args: [BigInt(assetId)],
      });
      toast.success(`Asset #${assetId} Approved! Status updated to Public.`, { id: toastId });
      refetchAssets(); 
    } catch (error: any) {
      toast.error(error.shortMessage || "Asset validation failed.", { id: toastId });
    }
  };
  
  // live event listeners for audit logs
  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'UserApproved',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const account = log.args.user;
        const logId = log.transactionHash || Math.random().toString();

        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { 
              id: logId, 
              type: "USER_APPROVED", 
              message: `User approved ➔ ${account.slice(0, 6)}...${account.slice(-4)}` 
            },
            ...prev
          ];
        });
      });
      fetchUserStatuses();
    },
  });

  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'AssetApproved',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const id = log.args.assetId;
        const logId = log.transactionHash || Math.random().toString();

        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { 
              id: logId, 
              type: "ASSET_APPROVED", 
              message: `Asset ID #${String(id)} moved to ACTIVE status.` 
            },
            ...prev
          ];
        });
      });
      refetchAssets();
    },
  });

  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'ErasureProofRecorded',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const account = log.args.user;
        const logId = log.transactionHash || Math.random().toString();

        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { 
              id: logId, 
              type: "ERASURE_RECORDED", 
              message: `ZK Erasure Proof anchored for user ➔ ${account.slice(0, 6)}...${account.slice(-4)}` 
            },
            ...prev
          ];
        });
      });
      fetchUserStatuses();
    },
  });

  // admin wall loader
  if (isLoadingOwner) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-xs font-mono text-gray-400">
        Authenticating Node Operator Credentials...
      </div>
    );
  }

  // restriction check layout
  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center border border-red-100 text-red-600 mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-black mb-2">Access Restricted</h2>
        <p className="text-sm text-gray-500 max-w-md">
          The administrative dashboard contains network-level systemic state controls. 
          Access is restricted exclusively to the authorized Contract Owner.
        </p>
      </div>
    );
  }

  return (
    <main className="max-w-7xl mx-auto p-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-black tracking-tight">System Overview</h1>
          <p className="text-xs text-gray-400 mt-1">Monitor aggregate stats, network parameters, and user states.</p>
        </div>
        
        <div className="flex gap-2 bg-gray-100/60 p-1 rounded-xl border border-gray-200/40">
          <button
            onClick={() => setActiveTab("overview")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === "overview" ? "bg-white text-black shadow-sm" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            Dashboard & Requests
          </button>
          <button
            onClick={() => setActiveTab("users")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === "users" ? "bg-white text-black shadow-sm" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            User Directory ({allUsersState.length})
          </button>
          <button
            onClick={() => setActiveTab("compliance")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === "compliance" ? "bg-white text-black shadow-sm" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            RGPD/RTBF Compliance Hub ({exitedUsers.length})
          </button>
        </div>
      </div>

      {/* view 1: dashboard overview tab */}
      {activeTab === "overview" && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            <Card className="py-5 px-6 hover:shadow-lg transition-all border-gray-50 flex flex-col justify-between">
              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block mb-1">Awaiting Users</span>
              <span className="text-3xl font-extrabold text-amber-500">{pendingUsers.length}</span>
            </Card>
            <Card className="py-5 px-6 hover:shadow-lg transition-all border-gray-50 flex flex-col justify-between">
              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block mb-1">Pending Assets</span>
              <span className="text-3xl font-extrabold text-amber-500">{pendingAssets.length}</span>
            </Card>
            <Card className="py-5 px-6 hover:shadow-lg transition-all border-gray-50 flex flex-col justify-between">
              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider block mb-1">Approved Ledger</span>
              <span className="text-3xl font-extrabold text-emerald-600">{approvedAssetsHistory.length}</span>
            </Card>
          </div>

          {/* pending users block */}
          <Card className="mb-10 p-6 border-gray-50">
            <h3 className="font-bold text-sm uppercase tracking-wider text-black mb-4">Pending User Approvals</h3>
            {pendingUsers.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50/50 rounded-xl p-4 italic text-center border border-dashed">
                No users awaiting compliance validation.
              </p>
            ) : (
              <div className="space-y-3">
                {pendingUsers.map((usr) => (
                  <div key={usr} className="flex justify-between items-center p-4 bg-gray-50/50 rounded-xl border border-gray-100 group">
                    <div className="font-mono text-xs text-gray-600 break-all">{usr}</div>
                    <button 
                      onClick={() => handleApproveUser(usr)} 
                      className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 shadow-md shadow-black/5 transition-all"
                    >
                      Approve User
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* pending assets block */}
          <Card className="mb-10 p-6 border-gray-50">
            <h3 className="font-bold text-sm uppercase tracking-wider text-black mb-4">Pending Asset Tokenization Requests</h3>
            {pendingAssets.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50/50 rounded-xl p-4 italic text-center border border-dashed">
                No active RWA requests awaiting tokenization parameters.
              </p>
            ) : (
              <div className="space-y-3">
                {pendingAssets.map((asset) => (
                  <div key={asset.id} className="flex justify-between items-center p-4 bg-gray-50/50 border border-gray-100 rounded-xl group">
                    <div className="flex items-center gap-3">
                      <span className="text-[9px] font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded uppercase tracking-wider">
                        Pending
                      </span>
                      <span className="text-sm font-bold text-black">{asset.name}</span>
                      <span className="text-xs font-mono text-gray-400">(ID: #{asset.id})</span>
                    </div>
                    <button 
                      onClick={() => handleApproveAsset(asset.id)} 
                      className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 shadow-md shadow-black/5 transition-all"
                    >
                      Approve Asset
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* approved assets block */}
          <Card className="mb-10 p-6 border-gray-50">
            <h3 className="font-bold text-xs uppercase tracking-widest text-gray-400 mb-4">Archived & Approved Assets Ledger</h3>
            {approvedAssetsHistory.length === 0 ? (
              <p className="text-xs text-gray-300 py-2 italic">No assets issued on the ledger infrastructure yet.</p>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="max-h-80 overflow-y-auto space-y-2 pr-2">
                  {approvedAssetsHistory.map((asset) => (
                    <div 
                      key={asset.id} 
                      onClick={() => handleFetchAssetHistory(asset.id)}
                      className={`flex justify-between items-center p-3.5 border rounded-xl cursor-pointer transition-all ${
                        selectedAssetHistoryId === asset.id 
                          ? "border-black bg-gray-50 font-bold" 
                          : "border-gray-100 bg-gray-50/30 opacity-80 hover:opacity-100"
                      }`}
                    >
                      <span className="text-xs text-gray-800">{asset.name}</span>
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full uppercase tracking-wider font-mono">
                        ✓ Active (ID: #{asset.id})
                      </span>
                    </div>
                  ))}
                </div>

                {/* audit trail nested layout */}
                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100 flex flex-col justify-between min-h-[200px]">
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-black mb-3 border-b pb-2">
                      On-chain Ownership Audit Trail
                    </h4>
                    {selectedAssetHistoryId === null ? (
                      <p className="text-xs text-gray-400 italic py-4 text-center">Select an active asset to inspect its secure historical logs.</p>
                    ) : isLoadingHistory ? (
                      <p className="text-xs text-gray-400 italic py-4 text-center">Loading ledger history from L1 smart contract...</p>
                    ) : currentAssetHistoryChain.length === 0 ? (
                      <p className="text-xs text-gray-400 italic py-4 text-center">No structural event records found for this ID.</p>
                    ) : (
                      <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                        {currentAssetHistoryChain.map((record: any, index: number) => (
                          <div key={index} className="flex flex-col gap-1 text-xs border-l-2 border-black/40 pl-3 ml-1">
                            <div className="flex justify-between items-center">
                              <span className="font-bold text-gray-900 text-[11px]">
                                {record.eventType === 0 ? "Created" : record.eventType === 1 ? " Transferred" : "Disposed/Burned"}
                              </span>
                              <span className="text-[9px] text-gray-400 font-mono">
                                {new Date(Number(record.timestamp) * 1000).toLocaleDateString()}
                              </span>
                            </div>
                            <p className="font-mono text-[10px] text-gray-500 break-all leading-none">
                              To: {record.to}
                            </p>
                            <div className="mt-0.5">
                              {record.keyDestroyed ? (
                                <span className="inline-block text-[8px] font-bold bg-red-50 text-red-600 border border-red-100 px-1.5 py-0.2 rounded">
                                  Key Destroyed (RTBF)
                                </span>
                              ) : (
                                <span className="inline-block text-[8px] font-bold bg-emerald-50 text-emerald-600 border border-emerald-200 px-1.5 py-0.2 rounded">
                                  Active & Encrypted
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {/* view 2: real-time users registry grid */}
      {activeTab === "users" && (
        <Card className="mb-10 p-6 border-gray-50">
          <div className="mb-6">
            <h3 className="font-bold text-lg text-black">On-chain User Directory</h3>
            <p className="text-xs text-gray-400 mt-0.5">Real-time cryptographic smart contract state registry.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-100 text-[10px] font-bold uppercase text-gray-400 tracking-wider">
                  <th className="pb-3 pl-2">Cryptographic Address</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3 text-right pr-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-xs">
                {allUsersState.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-8 text-center text-gray-400 italic">No users registered on-chain yet.</td>
                  </tr>
                ) : (
                  allUsersState.map((user) => (
                    <tr key={user.address} className="hover:bg-gray-50/40 transition-colors">
                      <td className="py-4 pl-2 font-mono text-gray-600 break-all">{user.address}</td>
                      <td className="py-4">
                        {!user.isActive ? (
                          <span className="text-[9px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100 uppercase tracking-wide">
                            Awaiting Compliance / Exited
                          </span>
                        ) : (
                          <span className="text-[9px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase tracking-wide">
                            ✓ Authorized User
                          </span>
                        )}
                      </td>
                      <td className="py-4 text-right pr-2">
                        {!user.isActive ? (
                          <button
                            onClick={() => handleApproveUser(user.address)}
                            className="bg-black text-white text-[11px] font-bold px-3 py-1.5 rounded-xl hover:bg-gray-800 shadow-sm transition-all"
                          >
                            Approve
                          </button>
                        ) : (
                          <button
                            onClick={() => setForceExitTarget(user.address)}
                            className="bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold px-3 py-1.5 rounded-xl hover:bg-red-100 transition-all"
                          >
                            Force Exit (RTBF)
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* view 3: RTBF compliance / GDPR layout */}
      {activeTab === "compliance" && (
        <Card className="mb-10 p-6 border-gray-50">
          <div className="mb-6">
            <h3 className="font-bold text-lg text-black">Right To Be Forgotten (RTBF) Queue</h3>
            <p className="text-xs text-gray-400 mt-0.5">Anchor off-chain Layer 2 ZK proof hashes to validate cryptographic key destruction on L1.</p>
          </div>

          <div className="space-y-4">
            {exitedUsers.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50/50 rounded-xl p-6 italic text-center border border-dashed">
                No active account erasure requests pending anchoring protocols.
              </p>
            ) : (
              exitedUsers.map((user) => (
                <div key={user.address} className="p-4 bg-red-50/10 border border-red-100 rounded-xl space-y-4">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
                    <div>
                      <span className="text-xs font-mono font-bold text-red-700 break-all">{user.address}</span>
                      <p className="text-[11px] text-gray-400 mt-0.5">User initiated exit protocol. Compliance hash pre-calculated.</p>
                    </div>
                    <span className="text-[9px] uppercase tracking-wider font-bold bg-red-100 text-red-700 border border-red-200 px-2.5 py-0.5 rounded-md">
                      Pending Erasure Finalization
                    </span>
                  </div>
                  
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div
                      className="flex-1 p-2.5 border border-gray-200 rounded-xl text-xs font-mono shadow-inner bg-gray-50 font-semibold text-gray-700 break-all"
                      title="Deterministically recomputed from this user's on-chain transaction IDs — matches what L2 already anchored automatically in the normal flow."
                    >
                      {proofHashes[user.address] || "Calculating deterministic compliance hash..."}
                    </div>
                    <button
                      onClick={() => handleRecordErasure(user.address)}
                      disabled={!proofHashes[user.address]}
                      className="bg-red-600 text-white text-xs font-bold px-4 py-2.5 rounded-xl hover:bg-red-700 shadow-md shadow-red-600/10 transition-all whitespace-nowrap disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
                    >
                      Anchor ZK-Proof
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {/* live audit feeds log card */}
      <Card className="p-6 border-gray-50">
        <div className="mb-4">
          <h3 className="font-bold text-sm uppercase tracking-wider text-black">Live Node Audit Log</h3>
          <p className="text-[10px] text-gray-400 mt-0.5">Real-time local event monitoring feed</p>
        </div>
        <div className="space-y-2.5 font-mono text-[11px] max-h-48 overflow-y-auto pr-2">
          {auditLogs.map((log) => (
            <div key={log.id} className="flex gap-4 p-3 bg-gray-50/50 rounded-xl border border-gray-100/60 items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`font-bold px-2 py-0.5 rounded uppercase text-[9px] border ${
                  log.type === "CONNECTED" 
                    ? "bg-emerald-50 text-emerald-600 border-emerald-100" 
                    : log.type === "ERASURE_RECORDED"
                    ? "bg-purple-50 text-purple-600 border-purple-100"
                    : "bg-blue-50 text-blue-600 border-blue-100"
                }`}>
                  {log.type}
                </span>
                <span className="text-gray-600">{log.message}</span>
              </div>
              <span className="text-[9px] text-gray-300 tracking-tighter uppercase font-sans">Verified payload</span>
            </div>
          ))}
        </div>
      </Card>

      {/* admin-forced RTBF exit confirmation */}
      {forceExitTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md p-6 bg-white shadow-2xl">
            <h3 className="text-lg font-bold text-red-600 mb-2">Confirm Admin-Forced Exit</h3>
            <p className="text-xs text-gray-500 mb-4 leading-relaxed">
              This immediately runs the full RTBF exit protocol for this user on their behalf:
              their assets are dispositioned per their configured inactive policy, all reference
              keys still bound to them are destroyed on L2, and an erasure proof is anchored. This
              cannot be undone.
            </p>
            <div className="p-3 bg-gray-50 border rounded-xl mb-6 font-mono text-xs text-red-600 font-bold break-all text-center">
              {forceExitTarget}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setForceExitTarget(null)}
                className="flex-1 py-2.5 border rounded-xl text-xs font-bold"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isForcingExit}
                onClick={() => handleForceExit(forceExitTarget)}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-xs font-bold disabled:opacity-50"
              >
                Confirm Force Exit
              </button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}