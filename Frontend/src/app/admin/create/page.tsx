'use client';
import { CreateAssetForm } from "@/components/createassetform";

export default function CreateAssetPage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2 text-black">Create New Asset</h1>
      <p className="text-gray-500 mb-8">Fill in the details to tokenize your asset on-chain.</p>
      <CreateAssetForm />
    </main>
  );
}
