import type { Metadata } from "next";
import "./globals.css";
import { Web3Providers } from "@/components/web3providers";
import Navbar from "@/components/navbar";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "blockchain.",
  description: "User and Admin Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Web3Providers>
          <Toaster position="top-right" richColors />
          <Navbar />
          {children}
        </Web3Providers>
      </body>
    </html>
  );
}