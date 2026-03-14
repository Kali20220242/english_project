import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthProvider } from "../components/auth-provider";
import { LanguageSwitcher } from "../components/language-switcher";
import { LocaleProvider } from "../components/locale-provider";

export const metadata: Metadata = {
  title: "NeonTalk",
  description: "AI English roleplay platform for modern conversational practice."
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="uk">
      <body>
        <AuthProvider>
          <LocaleProvider>
            <LanguageSwitcher />
            {children}
          </LocaleProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
