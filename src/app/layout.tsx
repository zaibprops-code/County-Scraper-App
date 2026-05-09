import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hillsborough County Lead Generator",
  description:
    "Automated probate and foreclosure lead generation from Hillsborough County, Florida court records.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
