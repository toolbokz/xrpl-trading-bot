import './globals.css';
import { ReactNode } from 'react';

export const metadata = {
    title: 'XRPL Trader Dashboard',
    description: 'Professional trading bot control for XRPL',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" className="dark">
            <body>{children}</body>
        </html>
    );
}
