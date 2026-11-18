import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { THEME_COLOR, THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plus-jakarta",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Command Center · Mailroom",
  description: "Agent coordination bus: conversations, team and temporary agents",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23080c11'/%3E%3Cpath d='M7 11l9 6 9-6' fill='none' stroke='%2378a9d8' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='7' y='9' width='18' height='14' rx='2' fill='none' stroke='%2378a9d8' stroke-width='2.2'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Shrink the layout when the on-screen keyboard opens (Chrome Android / Galaxy).
  interactiveWidget: "resizes-content",
  themeColor: THEME_COLOR.dark,
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${plusJakarta.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      {/* Keep vertical viewport overscroll available to Chrome's native refresh. */}
      <body className="h-full overflow-x-clip">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} themes={["dark", "light"]} storageKey={THEME_STORAGE_KEY} disableTransitionOnChange>
          <TooltipProvider delay={300}>
            {children}
            <Toaster closeButton />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
