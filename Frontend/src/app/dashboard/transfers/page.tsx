'use client';
import { Card } from "@/components/card";
import { useAccount, usePublicClient } from "wagmi";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI } from "@/contracts";
import { useState, useEffect } from "react";
import { toast } from "sonner";

interface RealTransfer {
  id: string; 
  date: string; 
  assetId: string;
  assetName: string;
  type: "Sent" | "Received";
  partyAddress: string; 
  status: "Confirmed";
}

export default function TransfersPage() {
  const { address: currentUserAddress } = useAccount();
  const publicClient = usePublicClient();
  
  const [transfers, setTransfers] = useState<RealTransfer[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchTransferHistory = async () => {
      if (!currentUserAddress || !publicClient) return;
      setIsLoading(true);

      try {
        // scan all transfer events from genesis block
        const transferLogs = await publicClient.getContractEvents({
          address: ASSET_REGISTRY_ADDRESS,
          abi: ASSET_REGISTRY_ABI,
          eventName: 'AssetTransferred',
          fromBlock: 0n,
        });

        const history: RealTransfer[] = [];

        // filter and parse logs for the connected wallet
        for (const log of transferLogs) {
          const { assetId, from, to } = (log as unknown as { args: { assetId: bigint; from: string; to: string } }).args;
          
          const isFromMe = from.toLowerCase() === currentUserAddress.toLowerCase();
          const isToMe = to.toLowerCase() === currentUserAddress.toLowerCase();

          if (isFromMe || isToMe) {
            
            // fetch block timestamp to extract real date
            let formattedDate = "Unknown Date";
            if (log.blockNumber) {
              try {
                const block = await publicClient.getBlock({
                  blockNumber: log.blockNumber,
                });
                const dateObject = new Date(Number(block.timestamp) * 1000);
                formattedDate = dateObject.toLocaleDateString("fr-FR", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                });
              } catch (err) {
                console.error("Could not fetch block timestamp", err);
              }
            }

            // resolve asset name from on-chain data
            let assetName = `Asset #${assetId.toString()}`;
            try {
              const assetData = await publicClient.readContract({
                address: ASSET_REGISTRY_ADDRESS,
                abi: ASSET_REGISTRY_ABI,
                functionName: 'assets',
                args: [assetId],
              }) as [bigint, string, number, bigint, boolean];
              
              if (assetData[1]) {
                assetName = assetData[1];
              }
            } catch (err) {
              console.error(`Could not fetch details for asset #${assetId}`, err);
            }

            history.push({
              id: log.transactionHash || Math.random().toString(),
              date: formattedDate,
              assetId: assetId.toString(),
              assetName: assetName,
              type: isFromMe ? "Sent" : "Received",
              partyAddress: isFromMe ? to : from,
              status: "Confirmed",
            });
          }
        }

        // sort by newest transfers first
        setTransfers(history.reverse());
      } catch (error) {
        console.error("Error loading transfer history logs:", error);
        toast.error("Could not load your transfer history from the ledger.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchTransferHistory();
  }, [currentUserAddress, publicClient]);

  if (!currentUserAddress) {
    return (
      <section className="max-w-7xl mx-auto p-8 text-black text-center">
        <h1 className="text-4xl font-bold mb-6">Transfers History</h1>
        <p className="text-gray-500">Please connect your Web3 wallet to see your history.</p>
      </section>
    );
  }

  return (
    <section className="max-w-7xl mx-auto p-8 text-black">
      <h1 className="text-4xl font-bold mb-10">Transfers History</h1>

      <Card className="overflow-hidden border-none shadow-sm">
        {isLoading ? (
          <div className="py-12 text-center text-gray-400 italic animate-pulse">
            Scanning blockchain events history and block timestamps...
          </div>
        ) : transfers.length === 0 ? (
          <div className="py-12 text-center text-gray-400 italic">
            No transfer records found for this account.
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="py-5 px-6 text-xs font-bold uppercase tracking-wider text-gray-400">Date</th>
                <th className="py-5 px-6 text-xs font-bold uppercase tracking-wider text-gray-400">Asset</th>
                <th className="py-5 px-6 text-xs font-bold uppercase tracking-wider text-gray-400">Type</th>
                <th className="py-5 px-6 text-xs font-bold uppercase tracking-wider text-gray-400">Recipient / Sender</th>
                <th className="py-5 px-6 text-xs font-bold uppercase tracking-wider text-gray-400">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {transfers.map((tx) => (
                <tr key={tx.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="py-5 px-6 text-sm text-gray-500 font-mono">
                    {tx.date}
                  </td>
                  <td className="py-5 px-6 text-sm">
                    <span className="font-bold text-black">{tx.assetName}</span>
                    <span className="text-xs text-gray-400 block font-mono">ID: #{tx.assetId}</span>
                  </td>
                  <td className="py-5 px-6 text-sm">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      tx.type === "Sent" ? "bg-red-50 text-red-600 border border-red-100" : "bg-blue-50 text-blue-600 border border-blue-100"
                    }`}>
                      {tx.type}
                    </span>
                  </td>
                  <td className="py-5 px-6 text-sm text-gray-500 font-mono break-all">
                    {tx.partyAddress}
                  </td>
                  <td className="py-5 px-6">
                    <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-green-100 text-green-700">
                      {tx.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}