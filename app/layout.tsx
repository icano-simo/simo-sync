import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "simo-sync",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
