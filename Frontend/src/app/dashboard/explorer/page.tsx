'use client';
import { Card } from "@/components/card";
import { useState, useEffect, useCallback } from "react";
import { useReadContract, useWriteContract, usePublicClient, useAccount, useSignMessage } from "wagmi";
import { keccak256, toHex, isAddress } from "viem";
import { toast } from "sonner";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, L2_SERVER_URL, CURRENCY_OPTIONS } from "@/contracts";
import { getAuthHeader } from "@/lib/l2Auth";

const ADMIN_ROLE_HASH = keccak256(toHex("ADMIN_ROLE")) as `0x${string}`;

interface GlobalAsset {
  id: string;
  rawId: bigint;
  name: string;
  owner: string;
  status: string;
  createdAt: bigint;
  valuations: any[];
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

export default function GlobalExplorerPage() {
  const publicClient = usePublicClient();
  const { address: userWalletAddress, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [globalAssets, setGlobalAssets] = useState<GlobalAsset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [currentPage, setCurrentPage] = useState(1);
  const assetsPerPage = 10;

  const [selectedAsset, setSelectedAsset] = useState<GlobalAsset | null>(null);
  const [assetHistory, setAssetHistory] = useState<AssetHistoryEvent[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [uniqueOwnersCount, setUniqueOwnersCount] = useState(1);
  const [l2AssetDetail, setL2AssetDetail] = useState<any>(null);
  const [imageDataUrls, setImageDataUrls] = useState<Record<string, string>>({});

  const [isAddingValuation, setIsAddingValuation] = useState(false);
  const [valuationCertifier, setValuationCertifier] = useState("");
  const [valuationValue, setValuationValue] = useState("");
  const [valuationCurrency, setValuationCurrency] = useState<typeof CURRENCY_OPTIONS[number]["code"]>("USD");
  const [isSubmittingValuation, setIsSubmittingValuation] = useState(false);

  // admin role check via hasRole — no owner() call, contract uses AccessControl
  const { data: isAdminRole, isLoading: isLoadingAdmin } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'hasRole',
    args: userWalletAddress ? [ADMIN_ROLE_HASH, userWalletAddress] : undefined,
    query: { enabled: mounted && isConnected && !!userWalletAddress },
  });

  const isAdmin = mounted && isConnected && !!userWalletAddress && !!isAdminRole;

  // single call returns all asset details — replaces N+1 loop
  const { data: allAssetsData } = useReadContract({
    address: ASSET_REGISTRY_ADDRESS,
    abi: ASSET_REGISTRY_ABI,
    functionName: 'getAllAssetsDetail',
    account: userWalletAddress,
    query: { enabled: !!isAdmin },
  });

  useEffect(() => {
    setCurrentPage(1);
  }, [search]);

  useEffect(() => {
    if (!allAssetsData || !isAdmin) return;
    const assets = (allAssetsData as any[]).map((detail: any) => ({
      id: `#${String(detail.id).padStart(4, '0')}`,
      rawId: BigInt(detail.id),
      name: detail.name,
      owner: detail.owner,
      status: Number(detail.status) === 0 ? "Pending" : "Public",
      createdAt: BigInt(detail.createdAt),
      valuations: detail.valuations || [],
    }));
    setGlobalAssets(assets);
    setIsLoading(false);
  }, [allAssetsData, isAdmin]);

  // fetch on-chain audit history when an asset is selected
  useEffect(() => {
    if (!selectedAsset || !publicClient || !isAdmin) return;
    setIsLoadingHistory(true);

    const fetchHistory = async () => {
      try {
        const historyData = await publicClient.readContract({
          address: ASSET_REGISTRY_ADDRESS,
          abi: ASSET_REGISTRY_ABI,
          functionName: 'getAssetHistory',
          args: [selectedAsset.rawId],
        }) as any;

        setUniqueOwnersCount(Number(historyData.uniqueOwnerCount) || 1);

        const chainRecords = historyData.chain || [];
        const formatted = chainRecords.map((record: any) => {
          const formattedDate = new Date(Number(record.timestamp) * 1000).toLocaleDateString("fr-FR", {
            day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
          });
          let displayType = "Ownership Transfer";
          if (Number(record.eventType) === 0) displayType = "Title Origination";
          if (Number(record.eventType) === 2) displayType = "Regulatory Asset Disposal";
          if (Number(record.eventType) === 3) displayType = "Asset Burned";
          if (record.keyDestroyed) displayType += " (Data Erased)";
          return {
            type: displayType,
            from: String(record.from),
            to: String(record.to),
            date: formattedDate,
            timestamp: Number(record.timestamp),
            txHash: record.transactionId ? record.transactionId.toString() : "0",
            keyDestroyed: !!record.keyDestroyed,
          };
        });

        setAssetHistory(formatted.sort((a: any, b: any) => b.timestamp - a.timestamp));
      } catch (err) {
        console.error(err);
        toast.error("Could not load this asset's on-chain audit timeline.");
      } finally {
        setIsLoadingHistory(false);
      }
    };

    fetchHistory();
  }, [selectedAsset?.rawId, publicClient, isAdmin]);

  // Fetches L2's aggregated view (L1 fields + L3-decrypted metadata) for one
  // asset. Extracted so it can be re-run after adding a valuation, not just
  // on initial selection.
  const fetchL2Detail = useCallback(async (assetId: bigint) => {
    if (!userWalletAddress) return;
    try {
      const authHeader = await getAuthHeader(userWalletAddress, signMessageAsync);
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
  }, [userWalletAddress, signMessageAsync]);

  // Kept in its own effect, independent of `publicClient` (a plain REST call,
  // not a contract read) — bundling it with the history effect above meant
  // any `publicClient` reference change (wagmi doesn't guarantee a stable
  // identity across renders) reset this back to null.
  useEffect(() => {
    if (!selectedAsset || !isAdmin) return;
    setL2AssetDetail(null);
    setImageDataUrls({});
    fetchL2Detail(selectedAsset.rawId);
  }, [selectedAsset?.rawId, isAdmin, fetchL2Detail]);

  // admin certifies a valuation for any asset, owned or not
  const handleAddValuation = async () => {
    if (!selectedAsset) return;

    const certifier = valuationCertifier.trim();
    if (!isAddress(certifier)) {
      toast.error("Please enter a valid certifier wallet address");
      return;
    }
    const trimmedValue = valuationValue.trim();
    if (!/^\d+$/.test(trimmedValue) || BigInt(trimmedValue) <= 0n) {
      toast.error("Please enter a whole number value greater than zero");
      return;
    }
    const currency = CURRENCY_OPTIONS.find(c => c.code === valuationCurrency)!;

    setIsSubmittingValuation(true);
    const toastId = toast.loading("Anchoring certified valuation on-chain...");
    try {
      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'addValuation',
        args: [selectedAsset.rawId, certifier as `0x${string}`, BigInt(trimmedValue), currency.hex as `0x${string}`],
      });
      toast.success("Valuation certified and anchored on-chain!", { id: toastId });
      setIsAddingValuation(false);
      setValuationCertifier("");
      setValuationValue("");
      setValuationCurrency("USD");
      fetchL2Detail(selectedAsset.rawId);
    } catch (error: any) {
      toast.error(error.shortMessage || "Failed to record valuation.", { id: toastId });
    } finally {
      setIsSubmittingValuation(false);
    }
  };

  if (!mounted || isLoadingAdmin) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-xs font-mono text-gray-400">
        Authenticating node operator credentials...
      </div>
    );
  }

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
          The global registry explorer contains restricted transaction audit streams.
          Access is restricted exclusively to the authorised contract admin.
        </p>
      </div>
    );
  }

  const filteredAssets = globalAssets.filter(asset =>
    asset.name.toLowerCase().includes(search.toLowerCase()) || asset.id.includes(search)
  );

  const indexOfLastAsset = currentPage * assetsPerPage;
  const indexOfFirstAsset = indexOfLastAsset - assetsPerPage;
  const currentAssets = filteredAssets.slice(indexOfFirstAsset, indexOfLastAsset);
  const totalPages = Math.ceil(filteredAssets.length / assetsPerPage);

  return (
    <section className="max-w-7xl mx-auto p-8 relative">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-black tracking-tight">Global Registry Explorer</h1>
        <p className="text-gray-500 mt-1">Complete on-chain asset ledger — admin view.</p>
      </div>

      <div className="relative flex items-center mb-8 w-full">
        <input
          type="text"
          placeholder="Search global ledger by ID or name..."
          className="w-full p-3 pr-12 rounded-xl border border-gray-100 bg-gray-50/50 outline-none focus:ring-2 focus:ring-black transition-all text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span aria-hidden="true" className="absolute right-2 p-2 text-gray-400">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.604 10.604z" />
          </svg>
        </span>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-gray-50 animate-pulse rounded-3xl" />
          ))}
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="p-12 text-center border-2 border-dashed rounded-3xl text-gray-400 italic">
          No assets found matching your search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {currentAssets.map((asset) => (
              <Card key={asset.id} className="p-6 border-gray-50 flex flex-col justify-between hover:shadow-xl hover:shadow-black/5 transition-all group">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-[10px] font-mono text-gray-400 uppercase">{asset.id}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                      asset.status === "Public"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-gray-100 text-gray-600 border-gray-200"
                    }`}>
                      {asset.status}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-black mb-4">{asset.name}</h3>
                </div>

                <div className="space-y-4">
                  <div className="pt-4 border-t border-gray-100 text-[11px] font-mono text-gray-400 break-all">
                    <span className="block text-[9px] font-bold uppercase text-gray-400 mb-0.5">Current Owner</span>
                    <span className="text-black font-semibold">
                      {asset.owner.startsWith("0x") && asset.owner.length > 10
                        ? `${asset.owner.slice(0, 6)}...${asset.owner.slice(-4)}`
                        : asset.owner}
                    </span>
                  </div>

                  <button
                    onClick={() => setSelectedAsset(asset)}
                    className="w-full bg-gray-50 text-black py-2.5 rounded-xl text-xs font-bold hover:bg-gray-100 transition-all border border-gray-100 text-center"
                  >
                    View Details
                  </button>
                </div>
              </Card>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="mt-12 flex items-center justify-center gap-4 border-t border-gray-100 pt-6">
              <button
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                disabled={currentPage === 1}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-100 bg-white hover:bg-gray-50 disabled:opacity-40 transition-all text-black"
              >
                ← Previous
              </button>
              <span className="text-xs font-medium text-gray-500 font-mono">
                Page <span className="text-black font-bold">{currentPage}</span> / {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                disabled={currentPage === totalPages}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-100 bg-white hover:bg-gray-50 disabled:opacity-40 transition-all text-black"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}

      {selectedAsset && (
        <>
          <div className="fixed inset-0 bg-black/10 backdrop-blur-[2px] z-40" onClick={() => setSelectedAsset(null)} />
          <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-white z-50 shadow-2xl p-8 overflow-y-auto">
            <button onClick={() => setSelectedAsset(null)} className="text-gray-400 hover:text-black mb-6 text-sm font-bold">
              ← Close Explorer Panel
            </button>

            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-black">{selectedAsset.name}</h2>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                selectedAsset.status === "Public"
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-gray-100 text-gray-600 border-gray-200"
              }`}>
                {selectedAsset.status === "Public" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                {selectedAsset.status}
              </span>
            </div>

            {/* stats row */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-1">Unique Owners</span>
                <span className="text-xl font-extrabold text-black">{uniqueOwnersCount}</span>
              </div>
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-center">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-1">Registered</span>
                <span className="text-sm font-extrabold text-black">
                  {selectedAsset.createdAt > 0n
                    ? new Date(Number(selectedAsset.createdAt) * 1000).toLocaleDateString("fr-FR")
                    : "—"}
                </span>
              </div>
            </div>

            {/* on-chain fields */}
            <div className="space-y-2 mb-4">
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-[11px] font-mono break-all">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Asset ID</span>
                <span className="text-black">{selectedAsset.id} (raw: {selectedAsset.rawId.toString()})</span>
              </div>
              <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl text-[11px] font-mono break-all">
                <span className="text-[9px] font-bold uppercase text-gray-400 block mb-0.5">Current Owner</span>
                <span className="text-black font-semibold">{selectedAsset.owner}</span>
              </div>
            </div>

            {/* L3 metadata (via L2 aggregation endpoint) */}
            {l2AssetDetail && (
              <div className="space-y-2 mb-4">
                {l2AssetDetail.metadata?.erased ? (
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
                )}

                {/* valuations */}
                {l2AssetDetail.valuations?.length > 0 && (
                  <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
                    <span className="text-[9px] font-bold uppercase text-gray-400 block mb-2">On-Chain Valuations</span>
                    <div className="space-y-1.5">
                      {l2AssetDetail.valuations.map((v: any, i: number) => (
                        <div key={i} className="flex justify-between items-center bg-white p-2 rounded border border-gray-100">
                          <div>
                            <span className="text-[9px] text-gray-400 block">
                              Certifier: {v.certifier.slice(0, 6)}...{v.certifier.slice(-4)}
                            </span>
                            <span className="text-xs font-bold text-black">
                              {Number(v.value).toLocaleString()} {v.currencyCode}
                            </span>
                          </div>
                          <span className="text-[9px] text-gray-400 font-mono">
                            {new Date(Number(v.certifiedAt) * 1000).toLocaleDateString("fr-FR")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* add valuation — outside the l2AssetDetail gate so it still
                works if L2's aggregation call is temporarily unreachable */}
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl mb-4">
              {!isAddingValuation ? (
                <button
                  onClick={() => {
                    setValuationCertifier(userWalletAddress ?? "");
                    setIsAddingValuation(true);
                  }}
                  className="w-full text-center text-[11px] font-bold py-1.5 text-gray-600 hover:text-black transition-colors"
                >
                  + Add Valuation
                </button>
              ) : (
                <div className="space-y-2">
                  <span className="text-[9px] font-bold uppercase text-gray-400 block">Certify a Valuation</span>
                  <input
                    type="text"
                    placeholder="Certifier address (0x...)"
                    value={valuationCertifier}
                    onChange={(e) => setValuationCertifier(e.target.value)}
                    className="w-full p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-black"
                  />
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="Value (smallest unit, e.g. cents)"
                      value={valuationValue}
                      onChange={(e) => setValuationValue(e.target.value)}
                      className="flex-1 p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-black"
                    />
                    <select
                      value={valuationCurrency}
                      onChange={(e) => setValuationCurrency(e.target.value as typeof valuationCurrency)}
                      className="p-2 bg-white border border-gray-200 rounded-lg text-[11px] font-bold focus:outline-none focus:ring-1 focus:ring-black"
                    >
                      {CURRENCY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
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
                      Certify
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ownership timeline */}
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase mb-4 tracking-wider">On-Chain Audit Timeline</p>

              {isLoadingHistory ? (
                <div className="space-y-2">
                  <div className="h-12 bg-gray-50 rounded-xl animate-pulse" />
                  <div className="h-12 bg-gray-50 rounded-xl animate-pulse" />
                </div>
              ) : assetHistory.length === 0 ? (
                <div className="p-4 bg-gray-50/50 rounded-xl text-center text-xs text-gray-400 italic border border-dashed">
                  No standard transfers observed. Asset retains genesis state ownership.
                </div>
              ) : (
                <div className="space-y-3">
                  {assetHistory.map((evt, idx) => (
                    <div key={idx} className="p-3 bg-gray-50/50 rounded-xl border border-gray-100 flex justify-between items-start text-xs">
                      <div>
                        <p className="font-bold text-black flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${evt.keyDestroyed ? 'bg-red-500' : 'bg-blue-500'}`} />
                          {evt.type}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          From: {evt.from.startsWith("0x") && evt.from.length > 10
                            ? `${evt.from.slice(0, 6)}...${evt.from.slice(-4)}`
                            : evt.from}
                        </p>
                        <p className="text-[10px] text-gray-400">
                          To: {evt.to.startsWith("0x") && evt.to.length > 10
                            ? `${evt.to.slice(0, 6)}...${evt.to.slice(-4)}`
                            : evt.to}
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-mono text-gray-400 block">{evt.date}</span>
                        <span className="text-[10px] text-gray-500 mt-1 inline-block font-mono">
                          TxID: {evt.txHash.length > 10 ? `${evt.txHash.slice(0, 6)}...` : evt.txHash}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
