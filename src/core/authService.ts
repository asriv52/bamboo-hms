import { recordAudit } from './audit';
import { getStaffByEmail, getStaffPasswordHash } from './entityStore';
import { verifyPassword } from './crypto';
import { normalizeEmail, ValidationError } from './validation';
import { Actor, Role, StaffUser } from './types';

/**
 * Authentication + role selection. Login returns the staff user on success and
 * a generic error on failure (never revealing whether email or password was
 * wrong). The caller (web transport) then resolves the active session role.
 */
export class AuthError extends Error {
  constructor(message = 'Invalid email or password.') {
    super(message);
    this.name = 'AuthError';
  }
}

export function login(emailRaw: string, password: string): StaffUser {
  let email: string;
  try {
    email = normalizeEmail(emailRaw);
  } catch {
    // Keep the error generic — do not leak which field was malformed.
    throw new AuthError();
  }
  const user = getStaffByEmail(email);
  if (!user) throw new AuthError();
  const hash = getStaffPasswordHash(user.id);
  if (!hash || !verifyPassword(password, hash)) throw new AuthError();
  return user;
}

/** Returns the role to auto-select, or null if the user must choose. */
export function resolveAutoRole(user: StaffUser): Role | null {
  return user.roles.length === 1 ? user.roles[0] : null;
}

export function buildActor(user: StaffUser, activeRole: Role): Actor {
  if (!user.roles.includes(activeRole)) {
    throw new ValidationError('You do not hold that role.');
  }
  const actor: Actor = {
    userId: user.id,
    activeRole,
    facilityCode: user.facilityCode,
    department: user.department,
    email: user.email,
    name: user.name,
  };
  recordAudit({
    actor,
    action: 'role_select',
    entity: 'session',
    entityId: user.id,
    detail: `Active role: ${activeRole}`,
  });
  return actor;
}
