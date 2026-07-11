import { Env } from '../env';

export const isDevelopment = (!Env.NODE_ENV || Env.NODE_ENV === 'development') && (!Env.APP_ENV || Env.APP_ENV === 'development');

export const isTest = Env.APP_ENV === 'test' || process.argv.includes('--test') || process.execArgv.includes('--test');

export function isTestEnvironment(): boolean {
    return isTest || Env.APP_ENV === 'test' || process.argv.includes('--test') || process.execArgv.includes('--test');
}

export function isDevelopmentEnvironment(): boolean {
    if (Env.NODE_ENV === undefined && Env.APP_ENV === undefined) return isDevelopment;
    return (!Env.NODE_ENV || Env.NODE_ENV === 'development') && (!Env.APP_ENV || Env.APP_ENV === 'development');
}
