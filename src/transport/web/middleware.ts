import { NextFunction, Request, Response } from 'express';
import { Actor, Role } from '../../core/types';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    email?: string;
    name?: string;
    facilityCode?: string;
    department?: string;
    roles?: Role[];
    activeRole?: Role;
  }
}

/** Build the per-request Actor from the session, or null if not fully logged in. */
export function actorFromSession(req: Request): Actor | null {
  const s = req.session;
  if (!s.userId || !s.activeRole || !s.facilityCode || !s.email || !s.name) {
    return null;
  }
  return {
    userId: s.userId,
    activeRole: s.activeRole,
    facilityCode: s.facilityCode,
    department: s.department || 'General',
    email: s.email,
    name: s.name,
  };
}

/** Require a fully authenticated session with an active role. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const actor = actorFromSession(req);
  if (!actor) {
    res.redirect('/login');
    return;
  }
  res.locals.actor = actor;
  next();
}

/** Require that the active role is one of the allowed roles. */
export function requireWebRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = actorFromSession(req);
    if (!actor) {
      res.redirect('/login');
      return;
    }
    if (!roles.includes(actor.activeRole)) {
      res.status(403).render('error', {
        title: 'Access denied',
        message: 'Your current role cannot open this page.',
        actor,
      });
      return;
    }
    res.locals.actor = actor;
    next();
  };
}
