import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Doc Forged AI — AI Document Forgery Detector",
  description:
    "Instantly detect forged or tampered documents using AI-powered Error Level Analysis, OCR anomaly detection, and font inconsistency checks. Upload any image or PDF to get a verdict in seconds.",
  keywords: [
    "document forgery detection",
    "ELA analysis",
    "fake document checker",
    "OCR anomaly",
    "PDF authenticity",
  ],
  openGraph: {
    title: "Doc Forged AI — AI Document Forgery Detector",
    description:
      "Upload any document image or PDF and get a real-time AI-powered forgery verdict.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
