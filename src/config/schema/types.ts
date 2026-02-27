export type EnvSchemaDomain = 'xrpl' | 'execution' | 'risk' | 'ui';
export type EnvValidationSeverity = 'error' | 'warning';

export interface EnvValidationIssue {
    domain: EnvSchemaDomain;
    severity: EnvValidationSeverity;
    code: string;
    message: string;
    envVar?: string | undefined;
}

export interface EnvValidationReport {
    ok: boolean;
    issues: EnvValidationIssue[];
}
