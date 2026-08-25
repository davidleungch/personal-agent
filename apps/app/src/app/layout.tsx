import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  description: "Personal autonomous agent platform",
  title: "Personal Agent"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
