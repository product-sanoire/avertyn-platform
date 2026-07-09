import "./globals.css";

export const metadata = {
  title: "Avertyn — IDR Defense",
  description: "TPA / plan-side No Surprises Act IDR defense platform",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
