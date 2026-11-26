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
      <body className="h-full">
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
