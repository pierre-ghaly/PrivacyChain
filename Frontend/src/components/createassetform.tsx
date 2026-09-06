'use client';
import { useEffect, useRef, useState } from "react";
import { useWriteContract, useSignMessage } from "wagmi";
import { toast } from "sonner";
import { Card } from "@/components/card";
import { ASSET_REGISTRY_ADDRESS, ASSET_REGISTRY_ABI, L2_SERVER_URL } from "@/contracts";
import { getAuthHeader } from "@/lib/l2Auth";

interface KeyReadyPayload {
  txId: string;
  purpose: 'USER_PII' | 'ASSET_METADATA';
  assetId?: string;
  assetName?: string;
  user: string;
}

interface PendingMetadata {
  assetName: string;
  description: string;
  category: string;
  imageFile: File | null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Shared by the admin and self-service "create asset" pages: mints the asset
// on L1, then — once L2 signals the per-transaction key is ready — encrypts
// and stores the description/category/image on L3.
export function CreateAssetForm() {
  const [isPending, setIsPending] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const pendingMetadata = useRef<PendingMetadata | null>(null);

  // revoke the object URL on unmount so it doesn't leak
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  useEffect(() => {
    const handleKeyReady = async (e: Event) => {
      const { detail } = e as CustomEvent<KeyReadyPayload>;
      const pending = pendingMetadata.current;
      if (detail.purpose !== 'ASSET_METADATA' || !pending) return;
      if (detail.assetName !== pending.assetName) return;

      pendingMetadata.current = null;
      try {
        const authHeader = await getAuthHeader(detail.user, signMessageAsync);

        let imageCids: string[] = [];
        if (pending.imageFile) {
          const imageData = await fileToBase64(pending.imageFile);
          const imgRes = await fetch(`${L2_SERVER_URL}/l3/images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify({ txId: detail.txId, imageData, mimeType: pending.imageFile.type }),
          });
          if (!imgRes.ok) throw new Error(`L3 image upload failed (${imgRes.status})`);
          const imgBody = await imgRes.json();
          imageCids = [imgBody.cid];
        }

        const storeRes = await fetch(`${L2_SERVER_URL}/l3/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({
            txId: detail.txId,
            dataType: 'ASSET_METADATA',
            data: { description: pending.description, category: pending.category || undefined, imageCids },
          }),
        });
        if (!storeRes.ok) throw new Error(`L3 store failed (${storeRes.status})`);
        toast.success("Asset metadata encrypted and stored off-chain (L3).");
      } catch (err) {
        console.error(err);
        toast.error("Asset minted, but storing its metadata on L3 failed.");
      }
    };

    window.addEventListener('L2_KEY_READY', handleKeyReady);
    return () => window.removeEventListener('L2_KEY_READY', handleKeyReady);
  }, []);

  const handleMint = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPending(true);

    const toastId = toast.loading("Initiating minting transaction...");

    try {
      pendingMetadata.current = { assetName, description, category, imageFile };

      await writeContractAsync({
        address: ASSET_REGISTRY_ADDRESS,
        abi: ASSET_REGISTRY_ABI,
        functionName: 'createAsset',
        args: [assetName],
      });

      toast.success("Asset successfully minted on-chain!", { id: toastId });
      setAssetName("");
      setDescription("");
      setCategory("");
      setImageFile(null);
      setImagePreviewUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    } catch (error: any) {
      pendingMetadata.current = null;
      console.error(error);
      toast.error(error.shortMessage || "Transaction failed.", { id: toastId });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Card className="p-8">
      <form className="space-y-6" onSubmit={handleMint}>
        <div>
          <label className="block text-sm font-bold mb-2">Asset Name</label>
          <input
            required
            type="text"
            value={assetName}
            onChange={(e) => setAssetName(e.target.value)}
            placeholder="Ex: Luxury Apartment #42"
            className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-black outline-none transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-bold mb-2">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the asset (stored encrypted off-chain, Layer 3)..."
            className="w-full p-3 rounded-xl border border-gray-200 h-24 focus:ring-2 focus:ring-black outline-none transition-all"
          />
        </div>

        <div>
          <label className="block text-sm font-bold mb-2">Category</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Ex: Real Estate, Vehicle, Artwork"
            className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-black outline-none transition-all"
          />
        </div>

        <div>
          <label
            htmlFor="asset-image-upload"
            className="block p-6 border-2 border-dashed border-gray-100 rounded-2xl text-center bg-gray-50/30 cursor-pointer hover:border-gray-300 transition-all"
          >
            {imagePreviewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imagePreviewUrl} alt="Asset preview" className="w-full h-32 object-cover rounded-xl mb-2" />
            )}
            <p className="text-gray-400 text-sm">
              {imageFile ? imageFile.name : "Click to upload asset image"}
            </p>
            <p className="text-[10px] text-gray-300 mt-2">Encrypted and pinned to IPFS (Layer 3)</p>
          </label>
          <input
            id="asset-image-upload"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setImageFile(file);
              setImagePreviewUrl(prev => {
                if (prev) URL.revokeObjectURL(prev);
                return file ? URL.createObjectURL(file) : null;
              });
            }}
          />
        </div>

        <button
          type="submit"
          disabled={isPending}
          className={`w-full py-4 rounded-2xl font-bold transition-all shadow-lg shadow-black/5 ${
            isPending
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-black text-white hover:bg-gray-800 active:scale-[0.98]"
          }`}
        >
          {isPending ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              Waiting for Blockchain...
            </span>
          ) : (
            "Mint Asset"
          )}
        </button>
      </form>
    </Card>
  );
}
