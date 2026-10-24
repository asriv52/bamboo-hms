import { recordAudit } from '../../core/audit';
import {
  createStaffUser,
  getInviteByToken,
  getStaffByEmail,
  markInviteUsed,
} from '../../core/entityStore';
import { StaffInvite, StaffUser } from '../../core/types';
import { requireText, ValidationError } from '../../core/validation';

/**
 * Public invite activation. No authenticated actor — identity is proven by the
 * single-use, time-limited token. Validates the token, then creates the staff
 * account with the invited roles and department.
 */
export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

export function getValidInvite(token: string): StaffInvite {
  const invite = getInviteByToken(token);
  if (!invite) throw new InviteError('This invitation link is not valid.');
  if (invite.status === 'used') throw new InviteError('This invitation has already been used.');
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    throw new InviteError('This invitation has expired. Ask your admin to resend it.');
  }
  return invite;
}

export function activateInvite(
  token: string,
  input: { name: string; password: string }
): StaffUser {
  const invite = getValidInvite(token);
  const name = requireText(input.name, 'Name');
  const password = requireText(input.password, 'Password');
  if (password.length < 6) {
    throw new ValidationError('Choose a password of at least 6 characters.');
  }
  if (getStaffByEmail(invite.email)) {
    throw new InviteError('An account for this email already exists.');
  }

  const user = createStaffUser({
    email: invite.email,
    password,
    name,
    phone: null,
    facilityCode: invite.facilityCode,
    department: invite.department,
    roles: invite.roles,
    specialty: invite.specialty,
  });
  markInviteUsed(invite.id);

  recordAudit({
    actor: null,
    action: 'staff_activate',
    entity: 'staff_user',
    entityId: user.id,
    detail: `Activated via invite ${invite.id}`,
  });
  return user;
}
