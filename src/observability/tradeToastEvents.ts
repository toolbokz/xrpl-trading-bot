export type TradeToastEventType = 'ORDER_PLACED' | 'ORDER_FILLED';
export type TradeToastSide = 'BUY' | 'SELL';

export interface TradeToastEvent {
    type: TradeToastEventType;
    side?: TradeToastSide | undefined;
    correlationId?: string | undefined;
    pair: string;
    baseCurrency: string;
    quoteCurrency: string;
    baseAmount?: number | undefined;
    quoteAmount?: number | undefined;
    price?: number | undefined;
    feeQuote?: number | undefined;
    pnlQuote?: number | undefined;
    timestamp: string;
}
