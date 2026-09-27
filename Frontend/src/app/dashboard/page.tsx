'use client';
import { Card } from "@/components/card";
import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useReadContract, useWriteContract, useAccount, usePublicClient, useSignMessage, useWatchContractEvent } from "wagmi";
import { isAddress } from "viem";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, CURRENCY_OPTIONS, L2_SERVER_URL } from "@/contracts";
import { getAuthHeader } from "@/lib/l2Auth";
import Link from "next/link";

interface Asset {
  id: string;
  rawId: bigint;
  name: string;
  status: string;
  createdAt: bigint;
  owner: string;
  isPublic: boolean;
  contract: string;
}

interface AssetHistoryEvent {
  type: string;
  from: string;
  to: string;
  date: string;
  timestamp: number;
  txHash: string;
  keyDestroyed: boolean;
}

// A financial assertion (valuation or sale-price proposal) as returned by
// L2's GET /assertions — see L2/src/routes/assertions.ts. `data` is the
// decrypted L3 content (null while pending signature/auth, or if erased).
interface FinancialAssertion {
  txId: string;
  assetId: string;
  submittedBy: string;
  counterparty: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  // Both tracked independently — a sale-price proposal needs each side's
  // own on-chain confirmFinancialAssertion call; a solo valuation (no
  // counterparty) never needs either. See AssetRegistry.sol.
  sellerConfirmed: boolean;
  buyerConfirmed: boolean;
  data: Record<string, unknown> | null;
  erased: boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export default function MyAssetsPage() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const publicClient = usePublicClient();
  
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [blockchainAssets, setBlockchainAssets] = useState<Asset[]>([]);

  const [transferringAsset, setTransferringAsset] = useState<Asset | null>(null);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [securityCheckInput, setSecurityCheckInput] = useState("");
  const [isTransferring, setIsTransferring] = useState(false);

  const [assetHistory, setAssetHistory] = useState<AssetHistoryEvent[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [historySortOrder, setHistorySortOrder] = useState<"desc" | "asc">("desc");
  const [uniqueOwnersCount, setUniqueOwnersCount] = useState(1);
  const [daysOnPlatform, setDaysOnPlatform] = useState<string>("0");

  const [l2AssetDetail, setL2AssetDetail] = useState<any>(null);
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});

  const [assertions, setAssertions] = useState<Record<string, FinancialAssertion[]>>({});

  const [isAddingValuation, setIsAddingValuation] = useState(false);
  const [valuationEntity, setValuationEntity] = useState("");
  const [valuationValue, setValuationValue] = useState("");
  const [valuationCurrency, setValuationCurrency] = useState<typeof CURRENCY_OPTIONS[number]>("USD");
  const [isSubmittingValuation, setIsSubmittingValuation] = useState(false);

  const [isProposingSale, setIsProposingSale] = useState(false);
  const [salePriceRecipient, setSalePriceRecipient] = useState("");
  const [salePriceValue, setSalePriceValue] = useState("");
  const [salePriceCurrency, setSalePriceCurrency] = useState<typeof CURRENCY_OPTIONS[number]>("USD");
  const [isSubmittingSalePrice, setIsSubmittingSalePrice] = useState(false);
  const [isCompletingSale, setIsCompletingSale] = useState(false);
  const [confirmingTxId, setConfirmingTxId] = useState<string | null>(null);

  // Held across the mint-txId -> KEY_READY -> POST-content two-step write
  // pattern (see createassetform.tsx for the original version of this).
  const pendingAssertion = useRef<{ assetId: string; dataType: 'VALUATION' | 'SALE_PRICE'; data: Record<string, unknown> } | null>(null);

  const { data: userData } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'users',
    args: address ? [address] : undefined,
    query: { enabled: !!address }
  });

  const isRegistered = userData ? (userData as any)[0] : false;
  const isActive = userData ? (userData as any)[1] : false;

  // isRegistered && !isActive covers both "never approved yet" and "exited
  // via RTBF" — exitTimestamp (only ever written by an actual exit) is the
  // signal that tells them apart, same approach as admin/page.tsx.
  const { data: exitStatusData } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getExitStatus',
    args: address ? [address] : undefined,
    query: { enabled: !!address && isRegistered && !isActive }
  });
  const hasExited = exitStatusData ? (exitStatusData as [boolean, bigint, boolean])[1] > 0n : false;

  // fetch current user assets from contract — single call returns all detail fields
  const { data: userAssetsData, isLoading, refetch } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getUserAssetsDetail',
    args: address ? [address] : undefined,
    account: address,
    query: { enabled: !!address && isRegistered && isActive, retry: false }
  });

  // map AssetDetail[] returned by getUserAssetsDetail — no extra per-asset calls needed
  useEffect(() => {
    if (!userAssetsData) return;
    const detailList = userAssetsData as any[];
    const fullAssets = detailList.map((detail: any) => ({
      id: `#${String(detail.id).padStart(4, '0')}`,
      rawId: BigInt(detail.id),
      name: detail.name,
      // AssetLib.Status: 0 = PENDING, 1 = ACTIVE, 2 = REJECTED. Distinct from
      // isPublic below — this is the admin-approval state, not Explorer visibility.
      status: Number(detail.status) === 0 ? "Pending" : Number(detail.status) === 1 ? "Active" : "Rejected",
      createdAt: BigInt(detail.createdAt),
      owner: detail.owner as string,
      isPublic: detail.isPublic as boolean,
      contract: ASSET_REGISTRY_ADDRESS
    }));
    setBlockchainAssets(fullAssets);
  }, [userAssetsData]);

  // keep the open drawer's data current after any refetch (e.g. a new valuation)
  useEffect(() => {
    if (!selectedAsset) return;
    const fresh = blockchainAssets.find(a => a.rawId === selectedAsset.rawId);
    if (fresh) setSelectedAsset(fresh);
  }, [blockchainAssets]);

  // Fetches L2's aggregated view (L1 fields + L3-decrypted metadata) for one
  // asset, same pattern as dashboard/explorer/page.tsx's fetchL2Detail.
  const fetchL2Detail = useCallback(async (assetId: bigint) => {
    if (!address) return;
    try {
      const authHeader = await getAuthHeader(address, signMessageAsync);
      const res = await fetch(`${L2_SERVER_URL}/assets/${assetId}`, {
        headers: { 'Authorization': authHeader },
      });
      if (res.ok) {
        const { asset } = await res.json();
        setL2AssetDetail(asset);

        const imageCids: string[] = asset.metadata?.imageCids ?? [];
        const entries: Array<[string, string] | null> = await Promise.all(imageCids.map(async (cid: string) => {
          try {
            const imgRes = await fetch(`${L2_SERVER_URL}/l3/retrieve/${cid}?txId=${asset.txId}`, {
              headers: { 'Authorization': authHeader },
            });
            if (!imgRes.ok) return null; // erased or not found — skip silently
            const { data } = await imgRes.json();
            const dataUrl: string = `data:${data.mimeType};base64,${data.data}`;
            return [cid, dataUrl];
          } catch {
            return null;
          }
        }));
        const validEntries: Array<[string, string]> = entries.filter((e): e is [string, string] => e !== null);
        setImageDataUrls(Object.fromEntries(validEntries));
      }
    } catch {
      // L2 offline, or signature declined — metadata section will not render
    }
  }, [address, signMessageAsync]);

  useEffect(() => {
    if (!selectedAsset) return;
    setL2AssetDetail(null);
    setImageDataUrls({});
    fetchL2Detail(selectedAsset.rawId);
  }, [selectedAsset?.rawId, fetchL2Detail]);

  // Fetches this asset's financial assertions (valuations + sale-price
  // proposals) via L2's aggregation route — each row already carries its
  // decrypted L3 content, no separate per-assertion fetch needed.
  const fetchAssertions = useCallback(async (assetId: bigint) => {
    if (!address) return;
    try {
      const authHeader = await getAuthHeader(address, signMessageAsync);
      const res = await fetch(`${L2_SERVER_URL}/assertions?assetId=${assetId}`, {
        headers: { 'Authorization': authHeader },
      });
      if (res.ok) {
        const { assertions: rows } = await res.json();
        setAssertions(prev => ({ ...prev, [assetId.toString()]: rows }));
      }
    } catch {
      // L2 offline, or signature declined — assertions panel just won't show anything
    }
  }, [address, signMessageAsync]);

  useEffect(() => {
    if (!selectedAsset) return;
    fetchAssertions(selectedAsset.rawId);
  }, [selectedAsset?.rawId, fetchAssertions]);

  // Live refresh when either party confirms — without this, a seller/buyer
  // viewing the drawer only sees the counterparty's confirmation after
  // closing and reopening it, since fetchAssertions otherwise only reruns on
  // asset-selection change or the viewer's own confirm/propose actions.
  useWatchContractEvent({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    eventName: 'FinancialAssertionConfirmed',
    onLogs() {
      if (selectedAsset) fetchAssertions(selectedAsset.rawId);
    },
  });

  // Two-step write pattern for financial assertions: requestFinancialAssertion
  // mints a txId on-chain (handleAddValuation/handleProposeSale below), then
  // once L2 derives its key and fires KEY_READY, the real content is POSTed
  // here — same shape as createassetform.tsx's ASSET_METADATA flow.
  useEffect(() => {
    const handleKeyReady = async (e: Event) => {
      const { detail } = e as CustomEvent<{ txId: string; purpose: string; assetId?: string; user: string }>;
      const pending = pendingAssertion.current;
      if (detail.purpose !== 'FINANCIAL_ASSERTION' || !pending) return;
      if (detail.assetId !== pending.assetId || detail.user.toLowerCase() !== address?.toLowerCase()) return;

      pendingAssertion.current = null;
      try {
        const authHeader = await getAuthHeader(detail.user, signMessageAsync);
        const storeRes = await fetch(`${L2_SERVER_URL}/l3/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({ txId: detail.txId, dataType: pending.dataType, data: pending.data }),
        });
        if (!storeRes.ok) throw new Error(`L3 store failed (${storeRes.status})`);
        toast.success(
          pending.dataType === 'SALE_PRICE'
            ? "Sale price proposed — awaiting buyer confirmation and admin approval."
            : "Valuation submitted — awaiting admin approval."
        );
        fetchAssertions(BigInt(pending.assetId));
      } catch (err) {
        console.error(err);
        toast.error("Assertion requested on-chain, but storing its content on L3 failed.");
      }
    };

    window.addEventListener('L2_KEY_READY', handleKeyReady);
    return () => window.removeEventListener('L2_KEY_READY', handleKeyReady);
  }, [address, signMessageAsync, fetchAssertions]);

  useEffect(() => {
    const fetchAssetTimeline = async () => {
      if (!selectedAsset || !publicClient) return;
      setIsLoadingHistory(true);
      setHistoryLimit(10); 

      const cleanId = selectedAsset.rawId;

      try {
        const historyData = await publicClient.readContract({
          address: ASSET_REGISTRY_ADDRESS,
          abi: ASSET_REGISTRY_ABI,
          functionName: 'getAssetHistory',
          args: [cleanId],
        }) as any;

        setUniqueOwnersCount(Number(historyData.uniqueOwnerCount));

        const chainRecords = historyData.chain || [];
        const formattedTimeline = chainRecords.map((record: any) => {
          const formattedDate = new Date(Number(record.timestamp) * 1000).toLocaleDateString("fr-FR", {
            day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
          });

          let displayType = "Ownership Transfer";
          if (Number(record.eventType) === 0) displayType = "Title Registration";
          if (Number(record.eventType) === 2) displayType = "Regulatory Asset Disposal";
          if (Number(record.eventType) === 3) displayType = "Asset Burned";

          if (record.keyDestroyed) {
            displayType += " (Data Erased)";
          }

          return {
            type: displayType,
            from: record.from,
            to: record.to,
            date: formattedDate,
            timestamp: Number(record.timestamp),
            txHash: record.transactionId.toString(),
            keyDestroyed: record.keyDestroyed
          };
        });

        setAssetHistory(formattedTimeline);

        const creationTimestamp = Number(selectedAsset.createdAt);
        let calculatedTimeDisplay = "0m";

        if (creationTimestamp > 0) {
          const totalSeconds = Math.floor(Date.now() / 1000) - creationTimestamp;
          
          if (totalSeconds < 60) {
            calculatedTimeDisplay = "Instant";
          } else if (totalSeconds < 3600) {
            calculatedTimeDisplay = `${Math.floor(totalSeconds / 60)}m`;
          } else if (totalSeconds < 86400) {
            calculatedTimeDisplay = `${Math.floor(totalSeconds / 3600)}h`;
          } else {
            calculatedTimeDisplay = `${Math.floor(totalSeconds / 86400)}d`;
          }
        }
        setDaysOnPlatform(calculatedTimeDisplay);

      } catch (err) {
        console.error(err);
        toast.error("Could not load this asset's on-chain audit timeline.");
      } finally {
        setIsLoadingHistory(false);
      }
    };

    fetchAssetTimeline();
  }, [selectedAsset?.rawId, publicClient]);

  const sortedHistory = [...assetHistory].sort((a, b) => {
    return historySortOrder === "desc" ? b.timestamp - a.timestamp : a.timestamp - b.timestamp;
  });

  const paginatedHistory = sortedHistory.slice(0, historyLimit);

  // validate addresses and open secondary transfer verification
  const handleOpenTransferConfirmation = (e: React.FormEvent, asset: Asset) => {
    e.preventDefault();
    const cleanAddress = recipientAddress.trim();

    if (!cleanAddress.startsWith("0x") || cleanAddress.length !== 42) {
      toast.error("Please enter a valid 42-character Ethereum address.");
      return;
    }
    if (address && cleanAddress.toLowerCase() === address.toLowerCase()) {
      toast.error("Security Trigger: Cannot transfer asset ownership to your own connected wallet.");
      return;
    }
    if (cleanAddress.toLowerCase() === ASSET_REGISTRY_ADDRESS.toLowerCase()) {
      toast.error("Security Trigger: Destination address cannot be the Ledger smart contract address.");
      return;
    }

    setTransferringAsset(asset);
    setIsConfirmModalOpen(true);
  };

  const handleFinalTransferAsset = async () => {
    if (!transferringAsset) return;

    const expectedCode = recipientAddress.trim().slice(-4).toLowerCase();
    if (securityCheckInput.trim().toLowerCase() !== expectedCode) {
      toast.error("Security Code Mismatch. Please check the recipient last 4 digits.");
      return;
    }

    setIsTransferring(true);
    const toastId = toast.loading("Executing secure on-chain asset ownership transfer...");

    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'transferAsset',
        args: [transferringAsset.rawId, recipientAddress.trim() as `0x${string}`],
        gas: 500000n, 
      });

      toast.success("Ownership title successfully transferred on L1 ledger!", { id: toastId });
      setIsConfirmModalOpen(false);
      setTransferringAsset(null);
      setRecipientAddress("");
      setSecurityCheckInput("");
      refetch(); 
    } catch (error: any) {
      console.error(error);
      toast.error(error.shortMessage || "Transfer aborted.", { id: toastId });
    } finally {
      setIsTransferring(false);
    }
  };

  // Request a solo valuation assertion for the currently-open (owned) asset.
  // Mints a txId on-chain (no value/entity in that call at all); the actual
  // content is POSTed to L3 once KEY_READY fires (see the effect above).
  const handleAddValuation = async () => {
    if (!selectedAsset || !address) return;

    const entity = valuationEntity.trim();
    if (!entity) {
      toast.error("Please enter who is asserting this value (e.g. an appraiser or gallery name)");
      return;
    }
    const trimmedValue = valuationValue.trim();
    if (!/^\d+$/.test(trimmedValue) || BigInt(trimmedValue) <= 0n) {
      toast.error("Please enter a whole number value greater than zero");
      return;
    }

    setIsSubmittingValuation(true);
    const toastId = toast.loading("Requesting financial assertion on-chain...");
    try {
      pendingAssertion.current = {
        assetId: selectedAsset.rawId.toString(),
        dataType: 'VALUATION',
        data: { value: Number(trimmedValue), currencyCode: valuationCurrency, entity },
      };
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'requestFinancialAssertion',
        args: [selectedAsset.rawId, ZERO_ADDRESS as `0x${string}`],
      });
      toast.success("Assertion minted on-chain — encrypting and storing its content off-chain...", { id: toastId });
      setIsAddingValuation(false);
      setValuationEntity("");
      setValuationValue("");
      setValuationCurrency("USD");
    } catch (error: any) {
      pendingAssertion.current = null;
      toast.error(error.shortMessage || "Failed to request valuation.", { id: toastId });
    } finally {
      setIsSubmittingValuation(false);
    }
  };

  // Propose a sale price to a named buyer — a genuine pre-transfer
  // negotiation step, not a decorative parallel track. The actual
  // transferAsset() call only becomes available once this assertion is
  // APPROVED (see handleCompleteSale / the gated button in the JSX below).
  const handleProposeSale = async () => {
    if (!selectedAsset || !address) return;

    const recipient = salePriceRecipient.trim();
    if (!isAddress(recipient)) {
      toast.error("Please enter a valid buyer wallet address");
      return;
    }
    const trimmedValue = salePriceValue.trim();
    if (!/^\d+$/.test(trimmedValue) || BigInt(trimmedValue) <= 0n) {
      toast.error("Please enter a whole number price greater than zero");
      return;
    }

    setIsSubmittingSalePrice(true);
    const toastId = toast.loading("Proposing sale price on-chain...");
    try {
      pendingAssertion.current = {
        assetId: selectedAsset.rawId.toString(),
        dataType: 'SALE_PRICE',
        data: { price: Number(trimmedValue), currencyCode: salePriceCurrency },
      };
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'requestFinancialAssertion',
        args: [selectedAsset.rawId, recipient as `0x${string}`],
      });
      toast.success("Sale price proposal minted on-chain — encrypting and storing its content off-chain...", { id: toastId });
      setIsProposingSale(false);
      setSalePriceRecipient("");
      setSalePriceValue("");
      setSalePriceCurrency("USD");
    } catch (error: any) {
      pendingAssertion.current = null;
      toast.error(error.shortMessage || "Failed to propose sale price.", { id: toastId });
    } finally {
      setIsSubmittingSalePrice(false);
    }
  };

  // Explicit on-chain confirmation from either party to a sale-price
  // proposal — required from BOTH seller and buyer before admin can approve
  // (enforced on-chain, not just in this UI; see confirmFinancialAssertion).
  // Submitting a proposal is not itself confirmation, so the seller confirms
  // separately too, same as the buyer.
  const handleConfirmAssertion = async (txId: string) => {
    setConfirmingTxId(txId);
    const toastId = toast.loading("Confirming price on-chain...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'confirmFinancialAssertion',
        args: [BigInt(txId)],
      });
      toast.success("Confirmed.", { id: toastId });
      if (selectedAsset) fetchAssertions(selectedAsset.rawId);
    } catch (error: any) {
      toast.error(error.shortMessage || "Failed to confirm.", { id: toastId });
    } finally {
      setConfirmingTxId(null);
    }
  };

  // Executes the actual transfer for an approved sale-price assertion —
  // the plain transferAsset() call, gated in the UI on the assertion's
  // APPROVED status (the contract itself has no knowledge of this link).
  const handleCompleteSale = async (assertion: FinancialAssertion) => {
    if (!selectedAsset || !assertion.counterparty) return;

    setIsCompletingSale(true);
    const toastId = toast.loading("Executing approved sale transfer...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'transferAsset',
        args: [selectedAsset.rawId, assertion.counterparty as `0x${string}`],
        gas: 500000n,
      });
      toast.success("Ownership title successfully transferred on L1 ledger!", { id: toastId });
      refetch();
    } catch (error: any) {
      toast.error(error.shortMessage || "Transfer aborted.", { id: toastId });
    } finally {
      setIsCompletingSale(false);
    }
  };

  // Owner-only — admin has no path to call this for someone else's asset,
  // enforced on-chain by setAssetVisibility itself, not just this UI.
  const handleSetAssetVisibility = async (assetId: bigint, isPublic: boolean) => {
    const toastId = toast.loading(isPublic ? "Making asset public..." : "Making asset private...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'setAssetVisibility',
        args: [assetId, isPublic],
      });
      toast.success(isPublic ? "Asset is now public in the Explorer." : "Asset is now private.", { id: toastId });
      refetch();
    } catch (error: any) {
      toast.error(error.shortMessage || "Failed to update visibility.", { id: toastId });
    }
  };

  const filteredAssets = blockchainAssets.filter(asset => {
    const matchesSearch = asset.name.toLowerCase().includes(search.toLowerCase()) || asset.id.includes(search);
    const matchesFilter = filter === "All" || asset.status === filter;
    return matchesSearch && matchesFilter;
  });

  return (
    <section className="max-w-7xl mx-auto p-8 relative">
      {/* action required warning badge */}
      {address && (!isRegistered || !isActive) && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
          <div>
            <h4 className="text-sm font-bold text-amber-800">Account Action Required</h4>
            <p className="text-xs text-amber-600">
              {!isRegistered
                ? "Your wallet is not registered on-chain yet. Please sign up using the registration menu."
                : hasExited
                ? "Your account has exited via the RTBF protocol — your data has been cryptographically erased."
                : "Your account is currently pending activation."}
            </p>
          </div>
        </div>
      )}

      {/* page header controls */}
      <div className="flex justify-between items-center mb-10">
        <div>
          <h1 className="text-4xl font-bold text-black tracking-tight">My Assets</h1>
          <p className="text-xs text-gray-400 mt-1">Connected to contract: {ASSET_REGISTRY_ADDRESS.slice(0, 20)}...</p>
        </div>

        {(!isRegistered || !isActive) ? (
          <button disabled className="px-6 py-3 rounded-2xl font-bold text-sm bg-gray-200 text-gray-400 cursor-not-allowed shadow-none">
            + Request Asset
          </button>
        ) : (
          <Link href="/dashboard/create" className="px-6 py-3 bg-black text-white hover:bg-gray-800 rounded-2xl font-bold transition-all text-sm shadow-lg shadow-black/10 text-center">
            + Request Asset
          </Link>
        )}
      </div>

      {/* filter and search layout row */}
      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <input 
          type="text" 
          placeholder="Search by ID or name..." 
          className="flex-1 p-3 rounded-xl border border-gray-100 bg-gray-50/50 outline-none focus:ring-2 focus:ring-black transition-all text-sm"
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-2 bg-gray-100/50 p-1 rounded-xl">
          {["All", "Active", "Pending", "Rejected"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                filter === f ? "bg-white text-black shadow-sm" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* responsive grid display */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-64 bg-gray-50 animate-pulse rounded-3xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {filteredAssets.map((asset) => (
            <Card key={asset.id} className="p-6 hover:shadow-xl hover:shadow-black/5 transition-all border-gray-50 group flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-bold text-gray-400 tracking-widest uppercase italic">
                  ID: {asset.id}
                </span>

                <div className="flex items-center gap-1.5">
                  {asset.status === "Active" ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      Active
                    </span>
                  ) : asset.status === "Rejected" ? (
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red-50 text-red-600 border border-red-200">
                      Rejected
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                      Pending
                    </span>
                  )}
                  {/* Explorer visibility — a separate axis from the approval status above */}
                  <span
                    title={asset.isPublic ? "Visible in the public Explorer (subject to your own privacy settings)" : "Private — not shown in the Explorer"}
                    className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-semibold border ${
                      asset.isPublic ? "bg-blue-50 text-blue-600 border-blue-200" : "bg-gray-50 text-gray-400 border-gray-100"
                    }`}
                  >
                    {asset.isPublic ? "Public" : "Private"}
                  </span>
                </div>
              </div>

              <h3 className="text-xl font-bold text-black mb-1 group-hover:text-gray-600 transition-colors">
                {asset.name}
              </h3>
              <p className="text-xs text-gray-400 mb-6">Status updated on-chain</p>

              <div className="flex gap-2 mt-auto">
                <button 
                  onClick={() => setSelectedAsset(asset)}
                  className="flex-1 bg-gray-50 text-black py-3 rounded-xl text-xs font-bold hover:bg-gray-100 transition-all border border-gray-100"
                >
                  View Details
                </button>
                <button
                  disabled={asset.status !== "Active" || !isRegistered || !isActive}
                  onClick={() => setTransferringAsset(transferringAsset?.rawId === asset.rawId ? null : asset)}
                  className={`flex-1 py-3 rounded-xl text-xs font-bold transition-all border ${
                    (asset.status !== "Active" || !isRegistered || !isActive)
                      ? "bg-gray-200 cursor-not-allowed text-gray-400 border-transparent"
                      : "bg-black text-white hover:bg-gray-800 border-black"
                  }`}
                >
                  {transferringAsset?.rawId === asset.rawId ? "Cancel" : "Transfer"}
                </button>
              </div>

              {transferringAsset?.rawId === asset.rawId && (
                <form 
                  onSubmit={(e) => handleOpenTransferConfirmation(e, asset)}
                  className="mt-4 pt-4 border-t border-gray-100 flex flex-col gap-2 animate-fadeIn"
                >
                  <label className="text-[10px] font-bold uppercase text-gray-400">Recipient Address</label>
                  <div className="flex gap-2">
                    <input
                      required
                      type="text"
                      placeholder="0x..."
                      value={recipientAddress}
                      onChange={(e) => setRecipientAddress(e.target.value)}
                      className="flex-1 p-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-black"
                    />
                    <button type="submit" className="bg-black hover:bg-gray-800 text-white font-bold text-xs px-3 rounded-lg transition-all">
                      Verify
                    </button>
                  </div>
                </form>
              )}
            </Card>
          ))}

          <Card className="p-12 border-dashed border-2 border-gray-100 flex flex-col items-center justify-center text-gray-400">
             <p className="italic text-sm mb-1">On-chain Total</p>
             <p className="text-[10px] font-bold text-black">{blockchainAssets.length} Assets Found</p>
          </Card>
        </div>
      )}

      {/* legal transfer verification modal */}
      {isConfirmModalOpen && transferringAsset && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md p-6 bg-white shadow-2xl">
            <h3 className="text-lg font-bold text-red-600 mb-2">Legal Title Transfer Review</h3>
            <div className="p-3 bg-gray-50 border rounded-xl mb-4 font-mono text-xs text-blue-600 font-bold break-all text-center">
              {recipientAddress}
            </div>
            <div className="space-y-3 mb-6">
              <label className="block text-[10px] font-bold uppercase text-gray-400">Enter last 4 characters of recipient address:</label>
              <input required maxLength={4} type="text" placeholder={`Type "${recipientAddress.slice(-4)}"`} value={securityCheckInput} onChange={(e) => setSecurityCheckInput(e.target.value)} className="w-full p-2.5 border rounded-xl text-center font-mono font-bold text-sm uppercase" />
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setIsConfirmModalOpen(false)} className="flex-1 py-2.5 border rounded-xl text-xs font-bold">Abort</button>
              <button type="button" disabled={securityCheckInput.toLowerCase() !== recipientAddress.slice(-4).toLowerCase() || isTransferring} onClick={handleFinalTransferAsset} className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-xs font-bold">Sign & Transfer Title</button>
            </div>
          </Card>
        </div>
      )}

      {/* side sliding asset analytical view drawer */}
      {selectedAsset && (
        <>
          <div className="fixed inset-0 bg-black/10 backdrop-blur-[2px] z-40" onClick={() => setSelectedAsset(null)} />
          <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-white z-50 shadow-2xl p-8 overflow-y-auto animate-slideIn">
            <button onClick={() => setSelectedAsset(null)} className="text-gray-400 hover:text-black mb-6 text-sm font-bold">
              Back to list
            </button>
            
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-black">{selectedAsset.name}</h2>
              <div className="flex items-center gap-1.5">
                {selectedAsset.status === "Active" ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
                  </span>
                ) : selectedAsset.status === "Rejected" ? (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red-50 text-red-600 border border-red-200">
                    Rejected
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                    Pending
                  </span>
                )}
                <span className={`inline-flex items-center px-2 py-1 rounded-full text-[10px] font-semibold border ${
                  selectedAsset.isPublic ? "bg-blue-50 text-blue-600 border-blue-200" : "bg-gray-50 text-gray-400 border-gray-100"
                }`}>
                  {selectedAsset.isPublic ? "Public" : "Private"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="p-4 bg-gray-50/50 border border-gray-100 rounded-xl text-center">
                <span className="text-[10px] text-gray-400 font-bold uppercase block mb-1">Unique Owners</span>
                <span className="text-xl font-extrabold text-black">{uniqueOwnersCount}</span>
              </div>
              <div className="p-4 bg-gray-50/50 border border-gray-100 rounded-xl text-center">
                <span className="text-[10px] text-gray-400 font-bold uppercase block mb-1">Time on Platform</span>
                <span className="text-xl font-extrabold text-black">{daysOnPlatform}</span>
              </div>
            </div>

            <div className="space-y-2 mb-6">
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Current Owner</span>
                <span className="text-[11px] font-mono break-all text-black font-semibold">{selectedAsset.owner}</span>
              </div>

              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Registered On-Chain</span>
                <span className="text-[11px] font-mono text-black">
                  {Number(selectedAsset.createdAt) > 0
                    ? new Date(Number(selectedAsset.createdAt) * 1000).toLocaleString("fr-FR")
                    : "—"}
                </span>
              </div>

              {/* L3 metadata (via L2 aggregation endpoint) */}
              {l2AssetDetail && (
                l2AssetDetail.metadata?.erased ? (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                    <p className="text-xs font-bold text-red-700 mb-1">RTBF Erasure Complete</p>
                    <p className="text-[10px] text-red-500 leading-relaxed">
                      Encrypted blob persists on IPFS but the decryption key (Kr) has been permanently destroyed.
                      The data is computationally inaccessible.
                    </p>
                  </div>
                ) : l2AssetDetail.metadata ? (
                  <div className="p-3 bg-blue-50/50 border border-blue-100 rounded-xl">
                    <span className="text-[9px] font-bold uppercase text-blue-400 block mb-2">L3 Encrypted Metadata</span>
                    {l2AssetDetail.metadata.description && (
                      <p className="text-[11px] text-gray-700 mb-2 leading-relaxed">{l2AssetDetail.metadata.description}</p>
                    )}
                    {l2AssetDetail.metadata.category && (
                      <span className="inline-block px-2 py-0.5 bg-white text-blue-700 text-[10px] font-bold rounded-full border border-blue-200 mb-2">
                        {l2AssetDetail.metadata.category}
                      </span>
                    )}
                    {l2AssetDetail.metadata.metadata && Object.keys(l2AssetDetail.metadata.metadata).length > 0 && (
                      <div className="grid grid-cols-2 gap-1 mt-2">
                        {Object.entries(l2AssetDetail.metadata.metadata as Record<string, string>).map(([k, v]) => (
                          <div key={k} className="bg-white p-1.5 rounded border border-blue-100">
                            <span className="text-[9px] uppercase font-bold text-gray-400 block">{k}</span>
                            <span className="text-[10px] font-semibold text-black">{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {l2AssetDetail.metadata.imageCids?.length > 0 && (
                      <div className="grid grid-cols-3 gap-1.5 mt-2">
                        {l2AssetDetail.metadata.imageCids.map((cid: string) => (
                          imageDataUrls[cid] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={cid} src={imageDataUrls[cid]} alt="Asset" className="w-full h-16 object-cover rounded-lg border border-blue-100" />
                          ) : (
                            <div key={cid} className="w-full h-16 rounded-lg border border-blue-100 bg-white animate-pulse" />
                          )
                        ))}
                      </div>
                    )}
                    {l2AssetDetail.metadataCid && (
                      <p className="text-[9px] font-mono text-gray-400 mt-2 break-all">
                        CID: {l2AssetDetail.metadataCid}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                    <span className="text-[9px] font-bold uppercase text-gray-400 block mb-1">L3 Encrypted Metadata</span>
                    <p className="text-[10px] text-gray-400 italic">No metadata stored in L3 for this asset.</p>
                  </div>
                )
              )}

              {/* Financial assertions — valuations and sale-price proposals.
                  Off-chain content (see requestFinancialAssertion), admin
                  decides on-chain (decideFinancialAssertion). */}
              {(assertions[selectedAsset.rawId.toString()] ?? []).length > 0 && (
                <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                  <span className="text-[9px] font-bold uppercase text-gray-400 block mb-2">Financial Assertions</span>
                  <div className="space-y-1.5">
                    {(assertions[selectedAsset.rawId.toString()] ?? []).map((a) => {
                      const isSeller = a.submittedBy.toLowerCase() === address?.toLowerCase();
                      const isBuyer = !!a.counterparty && a.counterparty.toLowerCase() === address?.toLowerCase();
                      const myConfirmed = isSeller ? a.sellerConfirmed : isBuyer ? a.buyerConfirmed : true;
                      const canConfirm = a.status === 'PENDING' && !!a.counterparty && (isSeller || isBuyer) && !myConfirmed;
                      return (
                      <div key={a.txId} className="bg-white p-2 rounded border border-gray-100">
                        <div className="flex justify-between items-center">
                          <span className="text-[9px] text-gray-400 block">
                            {a.counterparty ? `Sale proposal → ${a.counterparty.slice(0, 6)}...${a.counterparty.slice(-4)}` : 'Valuation'}
                          </span>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                            a.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-700'
                              : a.status === 'REJECTED' ? 'bg-red-50 text-red-600'
                              : 'bg-amber-50 text-amber-600'
                          }`}>
                            {a.status}
                          </span>
                        </div>
                        {a.counterparty && a.status === 'PENDING' && (
                          <div className="flex gap-1 mt-1">
                            <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${a.sellerConfirmed ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                              Seller {a.sellerConfirmed ? '✓ confirmed' : 'waiting'}
                            </span>
                            <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${a.buyerConfirmed ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                              Buyer {a.buyerConfirmed ? '✓ confirmed' : 'waiting'}
                            </span>
                          </div>
                        )}
                        {a.erased ? (
                          <p className="text-[10px] text-gray-400 italic mt-1">Cryptographically erased.</p>
                        ) : a.data ? (
                          <span className="text-xs font-bold text-black block mt-1">
                            {a.counterparty
                              ? `${Number((a.data as any).price).toLocaleString()} ${(a.data as any).currencyCode}`
                              : `${Number((a.data as any).value).toLocaleString()} ${(a.data as any).currencyCode} — ${(a.data as any).entity}`}
                          </span>
                        ) : (
                          <p className="text-[10px] text-gray-400 italic mt-1">Awaiting your signature to decrypt…</p>
                        )}
                        {canConfirm && (
                          <button
                            onClick={() => handleConfirmAssertion(a.txId)}
                            disabled={confirmingTxId === a.txId}
                            className="w-full mt-2 py-1.5 bg-black text-white rounded-lg text-[11px] font-bold hover:bg-gray-800 disabled:opacity-50 transition-all"
                          >
                            Confirm Price ({isSeller ? 'Seller' : 'Buyer'})
                          </button>
                        )}
                        {a.status === 'APPROVED' && a.counterparty && isSeller && (
                          <button
                            onClick={() => handleCompleteSale(a)}
                            disabled={isCompletingSale}
                            className="w-full mt-2 py-1.5 bg-black text-white rounded-lg text-[11px] font-bold hover:bg-gray-800 disabled:opacity-50 transition-all"
                          >
                            Complete Transfer to Buyer
                          </button>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                {!isAddingValuation ? (
                  <button
                    onClick={() => setIsAddingValuation(true)}
                    className="w-full text-center text-[11px] font-bold py-1.5 text-gray-600 hover:text-black transition-colors"
                  >
                    + Add Valuation
                  </button>
                ) : (
                  <div className="space-y-2">
                    <span className="text-[9px] font-bold uppercase text-gray-400 block">Submit a Valuation</span>
                    <input
                      type="text"
                      placeholder="Entity (e.g. appraiser or gallery name)"
                      value={valuationEntity}
                      onChange={(e) => setValuationEntity(e.target.value)}
                      className="w-full p-2 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-1 focus:ring-black"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="Value"
                        value={valuationValue}
                        onChange={(e) => setValuationValue(e.target.value)}
                        className="flex-1 p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-black"
                      />
                      <select
                        value={valuationCurrency}
                        onChange={(e) => setValuationCurrency(e.target.value as typeof valuationCurrency)}
                        className="p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-bold focus:outline-none focus:ring-1 focus:ring-black"
                      >
                        {CURRENCY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setIsAddingValuation(false)}
                        className="flex-1 py-1.5 border border-gray-200 rounded-lg text-[11px] font-bold text-gray-500 hover:bg-gray-100 transition-all"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleAddValuation}
                        disabled={isSubmittingValuation}
                        className="flex-1 py-1.5 bg-black text-white rounded-lg text-[11px] font-bold hover:bg-gray-800 disabled:opacity-50 transition-all"
                      >
                        Submit
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Propose Sale — a genuine pre-transfer negotiation step,
                  separate from the card's plain no-price Transfer action. */}
              {selectedAsset.status === "Active" && selectedAsset.owner.toLowerCase() === address?.toLowerCase() && (
                <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                  {!isProposingSale ? (
                    <button
                      onClick={() => setIsProposingSale(true)}
                      className="w-full text-center text-[11px] font-bold py-1.5 text-gray-600 hover:text-black transition-colors"
                    >
                      + Propose Sale (negotiate a price)
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <span className="text-[9px] font-bold uppercase text-gray-400 block">Propose a Sale Price</span>
                      <input
                        type="text"
                        placeholder="Buyer address (0x...)"
                        value={salePriceRecipient}
                        onChange={(e) => setSalePriceRecipient(e.target.value)}
                        className="w-full p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-black"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="Price"
                          value={salePriceValue}
                          onChange={(e) => setSalePriceValue(e.target.value)}
                          className="flex-1 p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-black"
                        />
                        <select
                          value={salePriceCurrency}
                          onChange={(e) => setSalePriceCurrency(e.target.value as typeof salePriceCurrency)}
                          className="p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-bold focus:outline-none focus:ring-1 focus:ring-black"
                        >
                          {CURRENCY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <p className="text-[9px] text-gray-400">The buyer must confirm, then admin must approve, before the transfer can complete.</p>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => setIsProposingSale(false)}
                          className="flex-1 py-1.5 border border-gray-200 rounded-lg text-[11px] font-bold text-gray-500 hover:bg-gray-100 transition-all"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleProposeSale}
                          disabled={isSubmittingSalePrice}
                          className="flex-1 py-1.5 bg-black text-white rounded-lg text-[11px] font-bold hover:bg-gray-800 disabled:opacity-50 transition-all"
                        >
                          Propose
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Owner-only Explorer visibility toggle — never admin-settable
                  for an existing asset, see setAssetVisibility's NatSpec. */}
              {selectedAsset.owner.toLowerCase() === address?.toLowerCase() && (
                <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl flex justify-between items-center">
                  <div>
                    <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Explorer Visibility</span>
                    <span className="text-[10px] text-gray-400">Only you can change this — admin cannot.</span>
                  </div>
                  <button
                    onClick={() => handleSetAssetVisibility(selectedAsset.rawId, !selectedAsset.isPublic)}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
                      selectedAsset.isPublic ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-gray-600 border-gray-200"
                    }`}
                  >
                    {selectedAsset.isPublic ? "Public — make Private" : "Private — make Public"}
                  </button>
                </div>
              )}

              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Contract</span>
                <span className="text-[11px] font-mono break-all text-gray-500">{selectedAsset.contract}</span>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-4">
                <p className="text-[10px] font-bold text-gray-400 uppercase">On-Chain Audit Timeline</p>
                <button 
                  onClick={() => setHistorySortOrder(prev => prev === "desc" ? "asc" : "desc")}
                  className="text-[10px] font-bold text-gray-500 bg-gray-50 px-2 py-1 rounded border border-gray-100 hover:bg-gray-100"
                >
                  Sort: {historySortOrder === "desc" ? "Newest First" : "Oldest First"}
                </button>
              </div>

              {isLoadingHistory ? (
                <div className="space-y-2">
                  <div className="h-10 bg-gray-50 rounded-xl animate-pulse" />
                  <div className="h-10 bg-gray-50 rounded-xl animate-pulse" />
                </div>
              ) : paginatedHistory.length === 0 ? (
                <div className="p-4 bg-gray-50/50 rounded-xl text-center text-xs text-gray-400 italic border border-dashed">
                  No standard transfers observed. Asset retains absolute genesis state ownership.
                </div>
              ) : (
                <div className="space-y-3">
                  {paginatedHistory.map((evt, idx) => (
                    <div key={idx} className="p-3 bg-gray-50/50 rounded-xl border border-gray-100 flex justify-between items-start text-xs">
                      <div>
                        <p className="font-bold text-black flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${evt.keyDestroyed ? 'bg-red-500' : 'bg-blue-500'}`} /> {evt.type}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">From: {evt.from.slice(0, 6)}...{evt.from.slice(-4)}</p>
                        <p className="text-[10px] text-gray-400">To: {evt.to.slice(0, 6)}...{evt.to.slice(-4)}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-mono text-gray-400 block">{evt.date}</span>
                        <span className="text-[10px] text-gray-500 mt-1 inline-block font-mono">
                          TxID: {evt.txHash}
                        </span>
                      </div>
                    </div>
                  ))}

                  {assetHistory.length > historyLimit && (
                    <button 
                      onClick={() => setHistoryLimit(prev => prev + 10)}
                      className="w-full text-center text-[11px] font-bold py-2 bg-gray-50 rounded-lg hover:bg-gray-100 text-gray-500 border"
                    >
                      Show More Audit Events (+{assetHistory.length - historyLimit})
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}