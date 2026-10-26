export const metadata = {
  title: 'Lead CRM Management',
  description: 'Panache Events — Lead CRM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
