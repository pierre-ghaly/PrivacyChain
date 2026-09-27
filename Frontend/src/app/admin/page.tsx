'use client';
import { Card } from "@/components/card";
import { useReadContract, useWriteContract, useWatchContractEvent, usePublicClient, useAccount, useSignMessage } from "wagmi";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, L2_SERVER_URL } from "@/contracts";
import { getAuthHeader } from "@/lib/l2Auth";
import { toast } from "sonner";
import { useState, useEffect, useCallback } from "react";
import { keccak256, toHex } from "viem";

const ADMIN_ROLE_HASH = keccak256(toHex("ADMIN_ROLE")) as `0x${string}`;

interface BlockchainAsset {
  id: number;
  name: string;
  status: "Pending" | "Active" | "Rejected";
}

interface LogMessage {
  id: string;
  type: "CONNECTED" | "USER_APPROVED" | "ASSET_APPROVED" | "ERASURE_RECORDED" | "USER_REJECTED" | "ASSET_REJECTED" | "ASSERTION_CONFIRMED" | "ASSERTION_DECIDED";
  message: string;
}

interface UserRegistryState {
  address: string;
  isRegistered: boolean;
  isActive: boolean;
  isRejected: boolean;
}

// Mirrors L2/src/keyStore.ts's FinancialAssertion + the decrypted content
// enrichment routes/assertions.ts adds to every row.
interface FinancialAssertionRow {
  txId: string;
  assetId: string;
  submittedBy: string;
  counterparty: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  // Both required before admin's approval succeeds on-chain for a
  // sale-price row (counterparty set) — see AssetRegistry.decideFinancialAssertion.
  // A solo valuation (counterparty null) never needs either.
  sellerConfirmed: boolean;
  buyerConfirmed: boolean;
  data: Record<string, unknown> | null;
  erased: boolean;
}


export default function AdminPage() {
  const { address: userWalletAddress, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();

  const [activeTab, setActiveTab] = useState<"overview" | "users" | "compliance" | "platform">("overview");

  const [dynamicUserList, setDynamicUserList] = useState<string[]>([]);
  const [allUsersState, setAllUsersState] = useState<UserRegistryState[]>([]);
  const [pendingUsers, setPendingUsers] = useState<string[]>([]);
  const [exitedUsers, setExitedUsers] = useState<UserRegistryState[]>([]);
  const [rejectedUsers, setRejectedUsers] = useState<string[]>([]);

  const [pendingAssets, setPendingAssets] = useState<BlockchainAsset[]>([]);
  const [approvedAssetsHistory, setApprovedAssetsHistory] = useState<BlockchainAsset[]>([]);
  const [rejectedAssets, setRejectedAssets] = useState<BlockchainAsset[]>([]);

  const [proofHashes, setProofHashes] = useState<{ [address: string]: { hash: string; timestamp: number } }>({});
  const [selectedAssetHistoryId, setSelectedAssetHistoryId] = useState<number | null>(null);
  const [currentAssetHistoryChain, setCurrentAssetHistoryChain] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [forceExitTarget, setForceExitTarget] = useState<string | null>(null);
  const [isForcingExit, setIsForcingExit] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  // Admin's financial-assertion review queue — off-chain content fetched
  // via a signed L2 session, decision itself is on-chain (see handleDecideAssertion).
  const [pendingAssertions, setPendingAssertions] = useState<FinancialAssertionRow[]>([]);
  const [decidingAssertionTxId, setDecidingAssertionTxId] = useState<string | null>(null);

  const [auditLogs, setAuditLogs] = useState<LogMessage[]>([
    {
      id: "init",
      type: "CONNECTED",
      message: `Admin linked to contract ${ASSET_REGISTRY_ADDRESS.slice(0, 10)}...`
    }
  ]);

  const { data: isAdminRole, isLoading: isLoadingOwner } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'hasRole',
    args: userWalletAddress ? [ADMIN_ROLE_HASH, userWalletAddress] : undefined,
    query: { enabled: isConnected && !!userWalletAddress }
  });

  const isAdmin = isConnected && !!userWalletAddress && !!isAdminRole;

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

  // Platform-wide policy reads — forward-looking only, never retroactive on
  // an already-created asset (that stays owner-only, see setAssetVisibility).
  const { data: explorerAccessMode, refetch: refetchExplorerAccessMode } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'explorerAccessMode',
    query: { enabled: !!isAdmin },
  });

  const { data: platformDefaultAssetVisibility, refetch: refetchPlatformDefaultVisibility } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'platformDefaultAssetVisibility',
    query: { enabled: !!isAdmin },
  });

  const isExplorerPublic = Number(explorerAccessMode ?? 0) === 1;

  const [isUpdatingPlatformSetting, setIsUpdatingPlatformSetting] = useState(false);

  const handleSetExplorerAccessMode = async (mode: 0 | 1) => {
    setIsUpdatingPlatformSetting(true);
    const toastId = toast.loading("Updating Explorer access mode...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'setExplorerAccessMode',
        args: [mode],
      });
      toast.success(`Explorer is now ${mode === 1 ? "publicly browsable" : "registered users only"}.`, { id: toastId });
      refetchExplorerAccessMode();
    } catch (error: any) {
      toast.error(error.shortMessage || "Update failed.", { id: toastId });
    } finally {
      setIsUpdatingPlatformSetting(false);
    }
  };

  const handleSetDefaultAssetVisibility = async (isPublic: boolean) => {
    setIsUpdatingPlatformSetting(true);
    const toastId = toast.loading("Updating platform default...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'setDefaultAssetVisibility',
        args: [isPublic],
      });
      toast.success(`New assets now default to ${isPublic ? "public" : "private"}. Existing assets are unaffected.`, { id: toastId });
      refetchPlatformDefaultVisibility();
    } catch (error: any) {
      toast.error(error.shortMessage || "Update failed.", { id: toastId });
    } finally {
      setIsUpdatingPlatformSetting(false);
    }
  };

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
      const sorted = [...txIds].map(id => id.toString()).sort((a, b) => {
        const diff = BigInt(a) - BigInt(b);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });
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
          }) as [boolean, boolean, boolean];

          return {
            address: userAddress,
            isRegistered: userData[0],
            isActive: userData[1],
            isRejected: userData[2],
          };
        })
      );

      setAllUsersState(resolvedUsers);

      // isRegistered && !isActive covers three distinct cases — never-approved,
      // exited-via-RTBF, and rejected — disambiguated below (isRejected first,
      // since it's a direct field; then getExitStatus for the other two) so
      // each shows up in exactly the right admin queue.
      const pendingApproval: string[] = [];
      const exitedFiltered: UserRegistryState[] = [];
      const rejectedFiltered: string[] = [];
      const computedHashes: { [address: string]: { hash: string; timestamp: number } } = {};

      for (const u of resolvedUsers) {
        if (!u.isRegistered || u.isActive) continue;
        if (u.isRejected) {
          rejectedFiltered.push(u.address);
          continue;
        }
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
            const proofTimestamp = Number(exitStatus[1]);
            const realHash = await generateProductionErasureHash(u.address, proofTimestamp);
            computedHashes[u.address] = { hash: realHash, timestamp: proofTimestamp };
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
      setRejectedUsers(rejectedFiltered);
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

  // Permanent — rejectUser() destroys any keys already derived for this
  // address in L2 (reacting to the on-chain event), erasing whatever PII
  // was submitted before admin ever reviewed it.
  const handleRejectUser = async (userAddress: string) => {
    setIsRejecting(true);
    const toastId = toast.loading(`Rejecting user...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'rejectUser',
        args: [userAddress],
      });
      toast.success("User rejected — any submitted data has been erased.", { id: toastId });
      fetchUserStatuses();
    } catch (error: any) {
      toast.error(error.shortMessage || "Rejection failed.", { id: toastId });
    } finally {
      setIsRejecting(false);
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

  const handleRecordErasure = async (userAddress: string) => {
    const proof = proofHashes[userAddress];
    if (!proof) {
      toast.error("Compliance hash is still being computed — try again shortly.");
      return;
    }

    const toastId = toast.loading(`Anchoring ZK Erasure Proof...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'recordErasureProof',
        args: [userAddress, proof.hash as `0x${string}`, BigInt(proof.timestamp)],
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

  // split assets into pending/active/rejected — status is already in AssetDetail, no extra calls needed
  useEffect(() => {
    if (!allAssetsData || !isAdmin) return;
    const resolvedAssets = (allAssetsData as any[]).map((detail: any) => ({
      id: Number(detail.id),
      name: detail.name,
      status: (Number(detail.status) === 0 ? "Pending" : Number(detail.status) === 1 ? "Active" : "Rejected") as BlockchainAsset["status"]
    }));
    setPendingAssets(resolvedAssets.filter(a => a.status === "Pending"));
    setApprovedAssetsHistory(resolvedAssets.filter(a => a.status === "Active"));
    setRejectedAssets(resolvedAssets.filter(a => a.status === "Rejected"));
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
      toast.success(`Asset #${assetId} Approved! Status updated to Active.`, { id: toastId });
      refetchAssets();
    } catch (error: any) {
      toast.error(error.shortMessage || "Asset validation failed.", { id: toastId });
    }
  };

  // Permanent — rejectAsset() destroys the asset's L3 metadata key in L2
  // (reacting to the on-chain event), same erasure principle as rejectUser.
  const handleRejectAsset = async (assetId: number) => {
    setIsRejecting(true);
    const toastId = toast.loading(`Rejecting asset #${assetId}...`);
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'rejectAsset',
        args: [BigInt(assetId)],
      });
      toast.success(`Asset #${assetId} rejected — its stored metadata has been erased.`, { id: toastId });
      refetchAssets();
    } catch (error: any) {
      toast.error(error.shortMessage || "Rejection failed.", { id: toastId });
    } finally {
      setIsRejecting(false);
    }
  };

  // Fetches the admin review queue for financial assertions (valuations and
  // sale-price proposals awaiting a decision) via a signed L2 session.
  const fetchPendingAssertions = useCallback(async () => {
    if (!userWalletAddress) return;
    try {
      const authHeader = await getAuthHeader(userWalletAddress, signMessageAsync);
      const res = await fetch(`${L2_SERVER_URL}/assertions`, {
        headers: { 'Authorization': authHeader },
      });
      if (res.ok) {
        const { assertions } = await res.json();
        setPendingAssertions(assertions);
      }
    } catch {
      // L2 offline, or signature declined — queue just stays as last fetched
    }
  }, [userWalletAddress, signMessageAsync]);

  useEffect(() => {
    if (isAdmin) fetchPendingAssertions();
  }, [isAdmin, fetchPendingAssertions]);

  // Admin's governance decision — an on-chain transaction (decideFinancialAssertion),
  // not an L2 API call; L2's own listener reacts to the resulting event to
  // update its local record and, on rejection, destroy the assertion's key.
  const handleDecideAssertion = async (txId: string, approved: boolean) => {
    setDecidingAssertionTxId(txId);
    const toastId = toast.loading(approved ? "Approving assertion on-chain..." : "Rejecting assertion on-chain...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'decideFinancialAssertion',
        args: [BigInt(txId), approved],
      });
      toast.success(approved ? "Assertion approved." : "Assertion rejected — its content has been erased.", { id: toastId });
      fetchPendingAssertions();
    } catch (error: any) {
      toast.error(error.shortMessage || "Decision failed.", { id: toastId });
    } finally {
      setDecidingAssertionTxId(null);
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

  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'UserRejected',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const account = log.args.user;
        const logId = log.transactionHash || Math.random().toString();
        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { id: logId, type: "USER_REJECTED", message: `User rejected ➔ ${account.slice(0, 6)}...${account.slice(-4)}` },
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
    eventName: 'AssetRejected',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const id = log.args.assetId;
        const logId = log.transactionHash || Math.random().toString();
        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { id: logId, type: "ASSET_REJECTED", message: `Asset ID #${String(id)} rejected.` },
            ...prev
          ];
        });
      });
      refetchAssets();
    },
  });

  // Live refresh on either party confirming — without this, the seller/buyer
  // badges and the Approve button's readyForApproval gate only update on
  // mount or after admin's own decision, staying stale if a party confirms
  // while this page is already open.
  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'FinancialAssertionConfirmed',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const { txId, confirmedBy, bothConfirmed } = log.args;
        const logId = log.transactionHash || Math.random().toString();
        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            {
              id: logId,
              type: "ASSERTION_CONFIRMED",
              message: `Financial assertion txId=${String(txId)} confirmed by ${confirmedBy.slice(0, 6)}...${confirmedBy.slice(-4)}${bothConfirmed ? " — both parties now confirmed" : ""}.`,
            },
            ...prev
          ];
        });
      });
      fetchPendingAssertions();
    },
  });

  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'FinancialAssertionDecided',
    onLogs(logs: any) {
      if (!isAdmin) return;
      logs.forEach((log: any) => {
        const { txId, approved } = log.args;
        const logId = log.transactionHash || Math.random().toString();
        setAuditLogs(prev => {
          if (prev.some(l => l.id === logId)) return prev;
          return [
            { id: logId, type: "ASSERTION_DECIDED", message: `Financial assertion txId=${String(txId)} ${approved ? 'approved' : 'rejected'}.` },
            ...prev
          ];
        });
      });
      fetchPendingAssertions();
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
          <button
            onClick={() => setActiveTab("platform")}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === "platform" ? "bg-white text-black shadow-sm" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            Platform Settings
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
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRejectUser(usr)}
                        disabled={isRejecting}
                        className="bg-red-50 text-red-600 border border-red-200 text-xs font-bold px-4 py-2 rounded-xl hover:bg-red-100 transition-all disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleApproveUser(usr)}
                        className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 shadow-md shadow-black/5 transition-all"
                      >
                        Approve User
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* rejected users block */}
          {rejectedUsers.length > 0 && (
            <Card className="mb-10 p-6 border-gray-50">
              <h3 className="font-bold text-xs uppercase tracking-widest text-gray-400 mb-4">Rejected Registrations</h3>
              <div className="space-y-2">
                {rejectedUsers.map((usr) => (
                  <div key={usr} className="flex justify-between items-center p-3.5 bg-red-50/30 border border-red-100 rounded-xl">
                    <span className="font-mono text-xs text-gray-500 break-all">{usr}</span>
                    <span className="text-[9px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded uppercase tracking-wider">
                      Rejected — Erased
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

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
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRejectAsset(asset.id)}
                        disabled={isRejecting}
                        className="bg-red-50 text-red-600 border border-red-200 text-xs font-bold px-4 py-2 rounded-xl hover:bg-red-100 transition-all disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleApproveAsset(asset.id)}
                        className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 shadow-md shadow-black/5 transition-all"
                      >
                        Approve Asset
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* rejected assets block */}
          {rejectedAssets.length > 0 && (
            <Card className="mb-10 p-6 border-gray-50">
              <h3 className="font-bold text-xs uppercase tracking-widest text-gray-400 mb-4">Rejected Assets</h3>
              <div className="space-y-2">
                {rejectedAssets.map((asset) => (
                  <div key={asset.id} className="flex justify-between items-center p-3.5 bg-red-50/30 border border-red-100 rounded-xl">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-gray-600">{asset.name}</span>
                      <span className="text-xs font-mono text-gray-400">(ID: #{asset.id})</span>
                    </div>
                    <span className="text-[9px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded uppercase tracking-wider">
                      Rejected — Erased
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* pending financial assertions block */}
          <Card className="mb-10 p-6 border-gray-50">
            <div className="mb-4">
              <h3 className="font-bold text-sm uppercase tracking-wider text-black">Pending Financial Assertions</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">Valuations and sale-price proposals awaiting an on-chain decision. Figures are decrypted from L3 for review only — the decision itself carries no sensitive content on-chain.</p>
            </div>
            {pendingAssertions.length === 0 ? (
              <p className="text-xs text-gray-400 bg-gray-50/50 rounded-xl p-4 italic text-center border border-dashed">
                No financial assertions awaiting review.
              </p>
            ) : (
              <div className="space-y-3">
                {pendingAssertions.map((row) => {
                  // A solo valuation (no counterparty) never needs
                  // confirmation; a sale-price row needs both sides —
                  // enforced on-chain by decideFinancialAssertion itself,
                  // this just keeps the UI from offering a button that
                  // would revert.
                  const readyForApproval = !row.counterparty || (row.sellerConfirmed && row.buyerConfirmed);
                  return (
                  <div key={row.txId} className="flex justify-between items-center p-4 bg-gray-50/50 rounded-xl border border-gray-100">
                    <div className="text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[9px] font-bold text-gray-500 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded uppercase tracking-wider">
                          {row.counterparty ? "Sale Price" : "Valuation"}
                        </span>
                        <span className="font-bold text-black">Asset #{row.assetId}</span>
                        <span className="text-[9px] font-mono text-gray-400">txId {row.txId}</span>
                        {row.counterparty && (
                          <>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                              row.sellerConfirmed ? "text-emerald-600 bg-emerald-50 border border-emerald-100" : "text-gray-400 bg-gray-100 border border-gray-200"
                            }`}>
                              Seller {row.sellerConfirmed ? "✓" : "waiting"}
                            </span>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${
                              row.buyerConfirmed ? "text-emerald-600 bg-emerald-50 border border-emerald-100" : "text-gray-400 bg-gray-100 border border-gray-200"
                            }`}>
                              Buyer {row.buyerConfirmed ? "✓" : "waiting"}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-gray-500 break-all">
                        Submitted by: {row.submittedBy}
                        {row.counterparty && <> → Counterparty: {row.counterparty}</>}
                      </div>
                      {row.data && (
                        <div className="mt-1 text-[11px] text-gray-700 font-semibold">
                          {row.data.value !== undefined ? String(row.data.value) : row.data.price !== undefined ? String(row.data.price) : JSON.stringify(row.data)}
                          {row.data.currencyCode ? ` ${row.data.currencyCode}` : ''}
                          {row.data.entity ? ` — ${row.data.entity}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDecideAssertion(row.txId, false)}
                        disabled={decidingAssertionTxId === row.txId}
                        className="bg-red-50 text-red-600 border border-red-200 text-xs font-bold px-4 py-2 rounded-xl hover:bg-red-100 transition-all disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleDecideAssertion(row.txId, true)}
                        disabled={decidingAssertionTxId === row.txId || !readyForApproval}
                        title={readyForApproval ? undefined : "Waiting for both seller and buyer to confirm on-chain"}
                        className="bg-black text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-gray-800 shadow-md shadow-black/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                  );
                })}
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
                        {user.isRejected ? (
                          <span className="text-[9px] font-bold px-2.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-100 uppercase tracking-wide">
                            Rejected
                          </span>
                        ) : !user.isActive ? (
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
                        {user.isRejected ? (
                          <span className="text-[10px] text-gray-300 italic">No actions available</span>
                        ) : !user.isActive ? (
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => handleRejectUser(user.address)}
                              disabled={isRejecting}
                              className="bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold px-3 py-1.5 rounded-xl hover:bg-red-100 transition-all disabled:opacity-50"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => handleApproveUser(user.address)}
                              className="bg-black text-white text-[11px] font-bold px-3 py-1.5 rounded-xl hover:bg-gray-800 shadow-sm transition-all"
                            >
                              Approve
                            </button>
                          </div>
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
                      {proofHashes[user.address]?.hash || "Calculating deterministic compliance hash..."}
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

      {/* view 4: platform-wide policy settings */}
      {activeTab === "platform" && (
        <div className="space-y-6 mb-10">
          <Card className="p-6 border-gray-50">
            <h3 className="font-bold text-lg text-black mb-1">Explorer Access Mode</h3>
            <p className="text-xs text-gray-400 mb-5 leading-relaxed max-w-2xl">
              Controls who can open the public Explorer at all — not what any individual asset's visibility is.
              Registered-only keeps the Explorer behind a connected, registered wallet; Public allows anonymous,
              disconnected browsing of assets their owners have chosen to make public.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleSetExplorerAccessMode(0)}
                disabled={isUpdatingPlatformSetting}
                className={`flex-1 p-4 rounded-xl border text-left transition-all ${
                  !isExplorerPublic ? "border-black bg-gray-50 shadow-sm" : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <span className="block text-xs font-bold text-black mb-1">Registered Only</span>
                <span className="block text-[10px] text-gray-400">Explorer requires a connected, registered wallet.</span>
              </button>
              <button
                onClick={() => handleSetExplorerAccessMode(1)}
                disabled={isUpdatingPlatformSetting}
                className={`flex-1 p-4 rounded-xl border text-left transition-all ${
                  isExplorerPublic ? "border-black bg-gray-50 shadow-sm" : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <span className="block text-xs font-bold text-black mb-1">Public</span>
                <span className="block text-[10px] text-gray-400">Anonymous, disconnected visitors can browse public assets.</span>
              </button>
            </div>
          </Card>

          <Card className="p-6 border-gray-50">
            <h3 className="font-bold text-lg text-black mb-1">Default Visibility for New Assets</h3>
            <p className="text-xs text-gray-400 mb-5 leading-relaxed max-w-2xl">
              A forward-looking policy only — it sets the starting visibility for assets created from now on.
              Admin can never change the visibility of an asset that already exists; that decision belongs
              exclusively to its owner.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleSetDefaultAssetVisibility(false)}
                disabled={isUpdatingPlatformSetting}
                className={`flex-1 p-4 rounded-xl border text-left transition-all ${
                  !platformDefaultAssetVisibility ? "border-black bg-gray-50 shadow-sm" : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <span className="block text-xs font-bold text-black mb-1">Private by Default</span>
                <span className="block text-[10px] text-gray-400">New assets start hidden from the Explorer until their owner opts in.</span>
              </button>
              <button
                onClick={() => handleSetDefaultAssetVisibility(true)}
                disabled={isUpdatingPlatformSetting}
                className={`flex-1 p-4 rounded-xl border text-left transition-all ${
                  platformDefaultAssetVisibility ? "border-black bg-gray-50 shadow-sm" : "border-gray-100 hover:border-gray-200"
                }`}
              >
                <span className="block text-xs font-bold text-black mb-1">Public by Default</span>
                <span className="block text-[10px] text-gray-400">New assets start visible on the Explorer until their owner opts out.</span>
              </button>
            </div>
          </Card>
        </div>
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
                    : log.type === "USER_REJECTED" || log.type === "ASSET_REJECTED"
                    ? "bg-red-50 text-red-600 border-red-100"
                    : log.type === "ASSERTION_DECIDED" || log.type === "ASSERTION_CONFIRMED"
                    ? "bg-indigo-50 text-indigo-600 border-indigo-100"
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