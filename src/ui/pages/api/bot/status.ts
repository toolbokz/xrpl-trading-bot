import type { NextApiResponse } from 'next';
import { withLocalApi, LocalRequest } from '../../../lib/localApi';
import { withApiRouteContext } from '../../../lib/localApi/withApiRouteContext';
import { botController } from '../../../lib/botController';
import { ensureRuntimeHooks } from '../../../lib/runtimeHooks';
import { loadConfig } from '../../../../config';

export const config = {
    api: { bodyParser: false },
};

function handler(req: LocalRequest, res: NextApiResponse) {
    ensureRuntimeHooks();
    const state = botController.getState();
    const cfg = loadConfig();
    res.status(200).json({
        state,
        paperTrading: cfg.paperTrading,
        message: `Bot state is ${state.toLowerCase()}`,
        requestId: req.requestId,
    });
}

export default withLocalApi(withApiRouteContext(handler), { methods: ['GET'], skipAudit: true });
