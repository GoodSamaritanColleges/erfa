import { normalizeEmail, toBoolean } from './core';
import { all, findBy, getSetting, insert, newId, nowIso } from './store';
import { audit } from './audit';
import type { DepartmentRecord, SessionUser, UserRecord } from './types';

function fail(message: string, code = 'UNAUTHORIZED'): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

export function authenticate(idToken: string): SessionUser {
  if (!idToken) fail('Sign in with your registered Google account.');
  const clientId = getSetting('GOOGLE_CLIENT_ID');
  if (!clientId) fail('Google authentication is not configured. Ask an administrator to set GOOGLE_CLIENT_ID.', 'CONFIGURATION_REQUIRED');
  const cache = CacheService.getScriptCache();
  const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 80);
  let claimsText = cache.get(`idtoken:${digest}`);
  if (!claimsText) {
    const response = UrlFetchApp.fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) fail('Google sign-in could not be verified. Please sign in again.');
    claimsText = response.getContentText();
    cache.put(`idtoken:${digest}`, claimsText, 300);
  }
  const claims = JSON.parse(claimsText) as Record<string, string>;
  if (claims.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) fail('Google token audience or issuer is invalid.');
  if (claims.email_verified !== 'true' || Number(claims.exp) * 1000 <= Date.now()) fail('Google sign-in is expired or the email is not verified.');
  const email = normalizeEmail(claims.email);
  const allowedDomain = normalizeEmail(getSetting('ALLOWED_DOMAIN'));
  if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) fail(`Use an authorized ${allowedDomain} Google Workspace account.`);

  const user = all<UserRecord>('USERS').find((candidate) => normalizeEmail(candidate.EMAIL) === email);
  if (!user) {
    audit('ACCESS_DENIED', { FULL_NAME: claims.name || email, EMAIL: email } as SessionUser, '', '', '', 'Google account is not registered.');
    fail('Your Google account is not registered in eRFA.', 'NOT_REGISTERED');
  }
  if (!toBoolean(user.ACTIVE)) {
    audit('ACCESS_DENIED', user as SessionUser, '', '', '', 'Inactive user attempted access.');
    fail('Your eRFA account is inactive. Contact an administrator.', 'INACTIVE_USER');
  }
  const department = user.DEPARTMENT_ID ? findBy<DepartmentRecord>('DEPARTMENTS', 'DEPARTMENT_ID', user.DEPARTMENT_ID) : undefined;
  return { ...user, DEPARTMENT_NAME: department?.DEPARTMENT_NAME ?? '' };
}

export function requireCapability(user: SessionUser, capability: 'CAN_CREATE_RFA' | 'CAN_APPROVE_RFA' | 'CAN_IMPLEMENT_RFA' | 'IS_ADMIN'): void {
  if (!toBoolean(user[capability])) {
    audit('ACCESS_DENIED', user, '', '', '', `Missing capability ${capability}.`);
    fail('You do not have permission to perform this action.', 'FORBIDDEN');
  }
}

export function bootstrapAdmin(email: string, fullName: string): UserRecord {
  const admins = all<UserRecord>('USERS').filter((user) => toBoolean(user.IS_ADMIN));
  if (admins.length) throw new Error('An administrator already exists. Use the Admin UI to add or promote users.');
  const normalized = normalizeEmail(email);
  if (!normalized || !fullName.trim()) throw new Error('Email and full name are required.');
  const timestamp = nowIso();
  const admin: UserRecord = {
    USER_ID: newId('usr'), FULL_NAME: fullName.trim(), EMAIL: normalized, DEPARTMENT_ID: '', POSITION: '',
    CAN_CREATE_RFA: true, CAN_APPROVE_RFA: true, CAN_IMPLEMENT_RFA: true, IS_ADMIN: true, ACTIVE: true, CREATED_AT: timestamp, UPDATED_AT: timestamp
  };
  insert('USERS', admin);
  audit('USER_CREATED', admin as SessionUser, '', '', '', 'Initial administrator bootstrapped.');
  return admin;
}
