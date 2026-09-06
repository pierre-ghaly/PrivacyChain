'use client';
import { useState } from "react";
import { Card } from "./card";

export interface RegistrationPii {
  realName: string;
  email: string;
  address?: string;
}

export default function RegisterModal({
  address,
  onSign,
  onClose,
}: {
  address: string;
  onSign: (pii: RegistrationPii) => void;
  onClose: () => void;
}) {
  const [realName, setRealName] = useState("");
  const [email, setEmail] = useState("");
  const [physicalAddress, setPhysicalAddress] = useState("");

  const canSubmit = realName.trim().length > 0 && email.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSign({
      realName: realName.trim(),
      email: email.trim(),
      address: physicalAddress.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <Card className="max-w-md w-full text-center">
        <h2 className="text-2xl font-bold mb-2 text-black">Welcome to Blockbase</h2>
        <p className="text-gray-500 mb-6 text-sm">
          Wallet <span className="font-mono text-black">{address?.slice(0, 6)}...{address?.slice(-4)}</span> connected.
        </p>

        <div className="bg-blue-50 text-blue-700 p-4 rounded-xl text-sm mb-6 font-medium">
          This address is not registered yet.
        </div>

        {/* Collected off-chain: encrypted and stored in L3, keyed to this registration's Kr — never written on-chain. */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left mb-2">
          <div>
            <label className="block text-xs font-bold mb-1 text-gray-600">Full name</label>
            <input
              required
              type="text"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-black outline-none transition-all text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1 text-gray-600">Email</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-black outline-none transition-all text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1 text-gray-600">Address (optional)</label>
            <input
              type="text"
              value={physicalAddress}
              onChange={(e) => setPhysicalAddress(e.target.value)}
              placeholder="123 Main St, City"
              className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-black outline-none transition-all text-sm"
            />
          </div>

          <div className="flex flex-col gap-3 mt-4">
            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full bg-black text-white py-4 rounded-2xl font-bold hover:bg-gray-800 transition-all disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              Sign to Register
            </button>

            <button
              type="button"
              onClick={onClose}
              className="w-full text-gray-400 font-medium py-2 hover:text-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
