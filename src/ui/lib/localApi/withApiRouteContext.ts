import type { NextApiRequest, NextApiResponse } from 'next';
import { clearApiRouteContext, markApiRouteContext, runWithRequestContext } from '../../../xrpl/guard';

type ApiRouteHandler<Req extends NextApiRequest, Res extends NextApiResponse> =
    (req: Req, res: Res) => Promise<void> | void;

function extractRequestId(req: NextApiRequest): string | undefined {
    const reqWithRequestId = req as NextApiRequest & { requestId?: unknown };
    if (typeof reqWithRequestId.requestId === 'string' && reqWithRequestId.requestId.length > 0) {
        return reqWithRequestId.requestId;
    }

    const requestIdHeader = req.headers['x-request-id'];
    if (typeof requestIdHeader === 'string' && requestIdHeader.length > 0) {
        return requestIdHeader;
    }
    if (Array.isArray(requestIdHeader) && requestIdHeader.length > 0) {
        const first = requestIdHeader[0];
        if (typeof first === 'string' && first.length > 0) {
            return first;
        }
    }

    return undefined;
}

/**
 * Wraps Pages API handlers with request + API-route XRPL guard context markers.
 */
export function withApiRouteContext<Req extends NextApiRequest, Res extends NextApiResponse>(
    handler: ApiRouteHandler<Req, Res>,
): (req: Req, res: Res) => Promise<void> {
    return async (req: Req, res: Res): Promise<void> => {
        const requestId = extractRequestId(req);
        const context = typeof requestId === 'string' ? { requestId } : {};
        await runWithRequestContext(async () => {
            markApiRouteContext();
            try {
                await handler(req, res);
            } finally {
                clearApiRouteContext();
            }
        }, context);
    };
}
