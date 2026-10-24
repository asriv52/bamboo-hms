import { recordAudit } from '../../core/audit';
import { requireFeature } from '../../core/accessControl';
import {
  createAppointment,
  getAppointment,
  listAppointmentsForDoctor,
  listAppointmentsForPatient,
  updateAppointment,
} from '../../core/careStore';
import { getFacility, getPatientById, getStaffById, listStaffWithRole } from '../../core/entityStore';
import { Actor, Appointment } from '../../core/types';
import { optionalText, parseDateTimeUtc, ValidationError } from '../../core/validation';

/**
 * Appointment scheduler. Patients book, view, reschedule, and cancel their OWN
 * appointments (scoped by the portal session's patient id). Doctors see their
 * past, present, and future appointments. Booking an appointment does NOT grant
 * the doctor history access — only a visit or an explicit grant does.
 */

export class AppointmentError extends ValidationError {}

export interface AppointmentView extends Appointment {
  doctorName: string;
  facilityName: string;
  patientName?: string;
  isUpcoming: boolean;
}

function toView(a: Appointment, withPatient: boolean): AppointmentView {
  return {
    ...a,
    doctorName: getStaffById(a.doctorId)?.name ?? 'Doctor',
    facilityName: getFacility(a.facilityCode)?.name ?? a.facilityCode,
    patientName: withPatient ? getPatientById(a.patientId)?.name : undefined,
    isUpcoming: a.status === 'Scheduled' && new Date(a.scheduledAt).getTime() > Date.now(),
  };
}

export interface BookableDoctor {
  id: number;
  name: string;
  department: string;
  facilityCode: string;
  facilityName: string;
}

export function listBookableDoctors(): BookableDoctor[] {
  return listStaffWithRole('Doctor').map((d) => ({
    id: d.id,
    name: d.name,
    department: d.department,
    facilityCode: d.facilityCode,
    facilityName: getFacility(d.facilityCode)?.name ?? d.facilityCode,
  }));
}

// ---- Patient side -----------------------------------------------------------

export function listPatientAppointments(patientId: number): AppointmentView[] {
  return listAppointmentsForPatient(patientId).map((a) => toView(a, false));
}

export function bookAppointment(
  patientId: number,
  input: { doctorId: unknown; scheduledAt: unknown; reason: unknown }
): Appointment {
  const doctorId = Number(input.doctorId);
  const doctor = Number.isInteger(doctorId) ? getStaffById(doctorId) : null;
  if (!doctor || !doctor.roles.includes('Doctor')) {
    throw new AppointmentError('Choose a doctor from the list.');
  }
  const scheduledAt = parseDateTimeUtc(input.scheduledAt, 'Appointment time', { future: true });
  const appt = createAppointment({
    patientId,
    doctorId: doctor.id,
    facilityCode: doctor.facilityCode,
    scheduledAt,
    reason: optionalText(input.reason),
  });
  recordAudit({
    actor: null,
    action: 'appointment_book',
    entity: 'appointment',
    entityId: appt.id,
    detail: `Patient ${patientId} booked with doctor ${doctor.id}`,
  });
  return appt;
}

/** Load an appointment only if it belongs to this patient and is still changeable. */
function ownedScheduled(patientId: number, appointmentId: number): Appointment {
  const appt = getAppointment(appointmentId);
  if (!appt || appt.patientId !== patientId) {
    throw new AppointmentError('That appointment could not be found.');
  }
  if (appt.status !== 'Scheduled') {
    throw new AppointmentError('Only scheduled appointments can be changed.');
  }
  return appt;
}

export function rescheduleAppointment(
  patientId: number,
  appointmentId: number,
  scheduledAtRaw: unknown
): void {
  const appt = ownedScheduled(patientId, appointmentId);
  const scheduledAt = parseDateTimeUtc(scheduledAtRaw, 'New time', { future: true });
  updateAppointment(appt.id, { scheduledAt });
  recordAudit({
    actor: null,
    action: 'appointment_reschedule',
    entity: 'appointment',
    entityId: appt.id,
    detail: `Moved to ${scheduledAt}`,
  });
}

export function cancelAppointment(patientId: number, appointmentId: number): void {
  const appt = ownedScheduled(patientId, appointmentId);
  updateAppointment(appt.id, { status: 'Cancelled' });
  recordAudit({
    actor: null,
    action: 'appointment_cancel',
    entity: 'appointment',
    entityId: appt.id,
    detail: 'Cancelled by patient',
  });
}

// ---- Doctor side ------------------------------------------------------------

export function listDoctorAppointments(actor: Actor): {
  upcoming: AppointmentView[];
  past: AppointmentView[];
} {
  requireFeature(actor, 'appointments.doctor');
  const all = listAppointmentsForDoctor(actor.userId).map((a) => toView(a, true));
  return {
    upcoming: all.filter((a) => a.isUpcoming).reverse(), // soonest first
    past: all.filter((a) => !a.isUpcoming),
  };
}
