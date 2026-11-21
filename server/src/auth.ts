import crypto from 'node:crypto';
import * as cookieLib from 'cookie';
import type { Request, Response } from 'express';
import { COOKIE_NAME, COOKIE_SECRET } from './config.js';
import { queries, type User } from './db.js';

/**
 * Session tokens are `<userId>.<hmac>`. They live in a signed cookie, and the
 * client also keeps a copy in sessionStorage so two tabs of one browser can act
 * as two different people during a demo. GitHub OAuth replaces this later;
 * `users.id` stays the key everywhere.
 */
export function signToken(userId: string): string {
  const mac = crypto.createHmac('sha256', COOKIE_SECRET).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

export function verifyToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const userId = token.slice(0, idx);
  const expected = signToken(userId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

function tokenFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  const authHeader = Array.isArray(auth) ? auth[0] : auth;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice('Bearer '.length);
  const raw = headers.cookie;
  const cookieHeader = Array.isArray(raw) ? raw[0] : raw;
  if (!cookieHeader) return null;
  return cookieLib.parse(cookieHeader)[COOKIE_NAME] ?? null;
}

/** Resolves the caller from a Bearer token (per tab) or the session cookie. */
export function userFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): User | null {
  const userId = verifyToken(tokenFromHeaders(headers));
  if (!userId) return null;
  return queries.getUser.get(userId) ?? null;
}

export function currentUser(req: Request): User | null {
  return userFromHeaders(req.headers as Record<string, string | string[] | undefined>);
}

export function setSessionCookie(res: Response, userId: string): void {
  res.setHeader(
    'Set-Cookie',
    cookieLib.serialize(COOKIE_NAME, signToken(userId), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    }),
  );
}

export type Action = 'read_workspace' | 'edit_files' | 'approve_command';

/**
 * The single permission check. Roles are stored but ignored: any member may do
 * anything in the MVP.
 */
export function can(user: User | null, _action: Action, workspaceId: string): boolean {
  if (!user) return false;
  return Boolean(queries.getMembership.get(user.id, workspaceId));
}
