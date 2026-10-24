import { recordAudit } from '../../core/audit';
import { requireAdmin } from '../../core/accessControl';
import { randomToken } from '../../core/crypto';
import { nowUtc } from '../../core/db';
import {
  createInvite,
  getFacility,
  getStaffById,
  listInvitesByFacility,
  listStaffByFacility,
  upsertFacility,
  updateStaffRolesAndDepartment,
} from '../../core/entityStore';
import { enqueueEmail } from '../../core/notificationService';
import { Actor, Facility, Role, StaffInvite, StaffUser } from '../../core/types';
import { normalizeEmail, requireText, ValidationError } from '../../core/validation';

/**
 * Admin / HR module. Facility administration only — invite and manage staff and
 * maintain facility information. No patient access anywhere in this module.
 */

const VALID_ROLES: Role[] = ['Admin', 'Receptionist', 'Doctor', 'Pharmacy'];
const INVITE_TTL_HOURS = 72;

function parseRoles(raw: unknown): Role[] {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const roles = arr
    .map((r) => String(r).trim())
    .filter((r): r is Role => (VALID_ROLES as string[]).includes(r));
  if (roles.length === 0) {
    throw new ValidationError('Select at least one valid role.');
  }
  return [...new Set(roles)];
}

export function inviteStaff(actor: Actor, input: Record<string, any>): StaffInvite {
  requireAdmin(actor);
  const email = normalizeEmail(input.email);
  const roles = parseRoles(input.roles);
  const department = requireText(input.department, 'Department');

  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000).toISOString();
  const invite = createInvite({
    email,
    roles,
    department,
    facilityCode: actor.facilityCode,
    token: randomToken(24),
    expiresAt,
  });

  recordAudit({
    actor,
    action: 'staff_invite',
    entity: 'staff_invite',
    entityId: invite.id,
    detail: `Invited ${email} as ${roles.join(',')} in ${department}`,
  });

  enqueueEmail('staff_invite', email, {
    roles: roles.join(', '),
    department,
    facility: actor.facilityCode,
    token: invite.token,
  });

  return invite;
}

export function listStaff(actor: Actor): StaffUser[] {
  requireAdmin(actor);
  return listStaffByFacility(actor.facilityCode);
}

export function listInvites(actor: Actor): StaffInvite[] {
  requireAdmin(actor);
  return listInvitesByFacility(actor.facilityCode);
}

export function updateStaff(
  actor: Actor,
  staffId: number,
  input: Record<string, any>
): void {
  requireAdmin(actor);
  const staff = getStaffById(staffId);
  if (!staff || staff.facilityCode !== actor.facilityCode) {
    throw new ValidationError('That staff member could not be found at your facility.');
  }
  const roles = parseRoles(input.roles);
  const department = requireText(input.department, 'Department');
  updateStaffRolesAndDepartment(staffId, roles, department);
  recordAudit({
    actor,
    action: 'staff_update',
    entity: 'staff_user',
    entityId: staffId,
    detail: `Roles=${roles.join(',')} Department=${department}`,
  });
}

export function getFacilityProfile(actor: Actor): Facility | null {
  requireAdmin(actor);
  return getFacility(actor.facilityCode);
}

export function updateFacility(actor: Actor, input: Record<string, any>): Facility {
  requireAdmin(actor);
  const name = requireText(input.name, 'Facility name');
  const departments = String(input.departments || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (departments.length === 0) {
    throw new ValidationError('List at least one department (comma-separated).');
  }
  const facility = upsertFacility({
    code: actor.facilityCode,
    name,
    address: input.address ? String(input.address).trim() : null,
    phone: input.phone ? String(input.phone).trim() : null,
    departments,
    specialties: input.specialties ? String(input.specialties).trim() : null,
  });
  recordAudit({
    actor,
    action: 'facility_update',
    entity: 'facility',
    entityId: null,
    detail: `Updated ${facility.code}`,
  });
  return facility;
}
