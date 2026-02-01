import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config';
import { logger } from './logger';

export interface TradeRecord {
    timestamp: number;
    pair: string;
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    fee: number;
    pnl: number;
}

export class PnLTracker {
    private readonly rows: TradeRecord[] = [];
    private readonly csvPath: string;

    constructor() {
        const config = loadConfig();
        this.csvPath = path.resolve(process.cwd(), config.analytics.csvExportPath);
        this.ensureHeader();
    }

    record(trade: TradeRecord): void {
        this.rows.push(trade);
        this.appendCsv(trade);
    }

    private ensureHeader(): void {
        if (fs.existsSync(this.csvPath)) return;
        fs.writeFileSync(
            this.csvPath,
            'timestamp,pair,side,price,quantity,fee,pnl\n',
            { encoding: 'utf8' }
        );
    }

    private appendCsv(trade: TradeRecord): void {
        const line = `${trade.timestamp},${trade.pair},${trade.side},${trade.price},${trade.quantity},${trade.fee},${trade.pnl}\n`;
        fs.appendFile(this.csvPath, line, (err) => {
            if (err) {
                logger.error({ err }, 'Failed to append PnL CSV');
            }
        });
    }
}
