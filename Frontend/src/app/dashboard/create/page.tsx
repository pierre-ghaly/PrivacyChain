'use client';
import Link from "next/link";
import { CreateAssetForm } from "@/components/createassetform";

export default function RequestAssetPage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <Link href="/dashboard" className="text-xs font-bold text-gray-400 hover:text-black transition-colors">
        &larr; Back to My Assets
      </Link>
      <h1 className="text-3xl font-bold mt-4 mb-2 text-black">Create New Asset</h1>
      <p className="text-gray-500 mb-8">Fill in the details to tokenize your asset on-chain.</p>
      <CreateAssetForm />
    </main>
  );
}
