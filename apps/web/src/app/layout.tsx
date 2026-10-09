import type { Metadata } from "next";
import { WalletProvider } from "@/components/wallet";
import "./globals.css";
export const metadata: Metadata = {
  title: "Recora — Every cycle, accounted for",
  description:
    "Recurring payments, transparent escrow, and dispute resolution on Solana.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
