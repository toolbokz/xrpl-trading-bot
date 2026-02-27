import { validateExecutionEnv } from './execution';
import { validateRiskEnv } from './risk';
import { validateUiEnv } from './ui';
import { validateXrplEnv } from './xrpl';
import type { EnvValidationIssue, EnvValidationReport } from './types';

function sortIssues(issues: EnvValidationIssue[]): EnvValidationIssue[] {
    return [...issues].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
        if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
        return a.code.localeCompare(b.code);
    });
}

export function validateAllEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationReport {
    const issues = sortIssues([
        ...validateXrplEnv(env),
        ...validateExecutionEnv(env),
        ...validateRiskEnv(env),
        ...validateUiEnv(env),
    ]);

    return {
        ok: !issues.some((issue) => issue.severity === 'error'),
        issues,
    };
}

export type { EnvValidationIssue, EnvValidationReport };
