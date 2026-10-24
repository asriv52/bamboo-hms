import { Request, Response, Router } from 'express';
import { AccessDenied } from '../../core/accessControl';
import { AuthError, buildActor, login, resolveAutoRole } from '../../core/authService';
import { getStaffByEmail } from '../../core/entityStore';
import { listJobs } from '../../core/notificationService';
import { registerPatient, searchPatients } from '../../core/patientService';
import { ValidationError } from '../../core/validation';
import { Role } from '../../core/types';
import { getDashboard } from '../../modules/admin/dashboardService';
import {
  getFacilityProfile,
  inviteStaff,
  listInvites,
  listStaff,
  updateFacility,
  updateStaff,
} from '../../modules/admin/adminService';
import {
  activateInvite,
  getValidInvite,
  InviteError,
} from '../../modules/admin/inviteService';
import {
  lookupActivePlan,
  lookupByToken,
  recordDispensing,
} from '../../modules/pharmacy/pharmacyService';
import {
  finalizeConsultation,
  getPatientSummary,
  openVisit,
} from '../../modules/prescription/consultationService';
import { addToQueue, todaysQueue, transitionQueue } from '../../modules/queue/queueService';
import { actorFromSession, requireAuth, requireWebRole } from './middleware';

export const router = Router();

/** Map a thrown error to a friendly user message + status. */
function friendly(err: unknown): { status: number; message: string } {
  if (err instanceof ValidationError) return { status: 400, message: err.message };
  if (err instanceof InviteError) return { status: 400, message: err.message };
  if (err instanceof AccessDenied) return { status: 403, message: err.message };
  if (err instanceof AuthError) return { status: 401, message: err.message };
  // Unknown: log the detail server-side, show a generic message to the user.
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  return { status: 500, message: 'Something went wrong. Please try again.' };
}

// ---- Home / auth ----------------------------------------------------------

router.get('/', (req: Request, res: Response) => {
  const actor = actorFromSession(req);
  res.redirect(actor ? '/dashboard' : '/login');
});

router.get('/login', (req: Request, res: Response) => {
  res.render('login', { title: 'Sign in', error: null });
});

router.post('/login', (req: Request, res: Response) => {
  try {
    const user = login(req.body.email, req.body.password);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.name = user.name;
    req.session.facilityCode = user.facilityCode;
    req.session.department = user.department;
    req.session.roles = user.roles;

    const auto = resolveAutoRole(user);
    if (auto) {
      req.session.activeRole = auto;
      buildActor(user, auto);
      res.redirect('/dashboard');
    } else {
      // Multi-role: must choose.
      res.redirect('/select-role');
    }
  } catch (err) {
    const { message } = friendly(err);
    res.status(401).render('login', { title: 'Sign in', error: message });
  }
});

router.get('/select-role', (req: Request, res: Response) => {
  if (!req.session.userId || !req.session.roles) {
    res.redirect('/login');
    return;
  }
  res.render('select-role', { title: 'Choose role', roles: req.session.roles });
});

router.post('/select-role', (req: Request, res: Response) => {
  const user = req.session.email ? getStaffByEmail(req.session.email) : null;
  if (!user) {
    res.redirect('/login');
    return;
  }
  try {
    const role = req.body.role as Role;
    buildActor(user, role); // validates the user holds this role
    req.session.activeRole = role;
    res.redirect('/dashboard');
  } catch {
    res.redirect('/select-role');
  }
});

router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Dashboard (role-aware landing) --------------------------------------

router.get('/dashboard', requireAuth, (req: Request, res: Response) => {
  const actor = res.locals.actor;
  let stats = null;
  if (actor.activeRole === 'Admin') {
    stats = getDashboard(actor);
  }
  res.render('dashboard', { title: 'Dashboard', actor, stats });
});

// ---- Admin / HR -----------------------------------------------------------

router.get('/admin/staff', requireWebRole('Admin'), (req, res) => {
  const actor = res.locals.actor;
  res.render('admin-staff', {
    title: 'Staff',
    actor,
    staff: listStaff(actor),
    invites: listInvites(actor),
    facility: getFacilityProfile(actor),
    error: null,
    sent: req.query.invited === '1',
  });
});

router.post('/admin/invites', requireWebRole('Admin'), (req, res) => {
  const actor = res.locals.actor;
  try {
    inviteStaff(actor, req.body);
    res.redirect('/admin/staff?invited=1');
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('admin-staff', {
      title: 'Staff',
      actor,
      staff: listStaff(actor),
      invites: listInvites(actor),
      facility: getFacilityProfile(actor),
      error: message,
      sent: false,
    });
  }
});

router.post('/admin/staff/:id', requireWebRole('Admin'), (req, res) => {
  const actor = res.locals.actor;
  try {
    updateStaff(actor, Number(req.params.id), req.body);
    res.redirect('/admin/staff');
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor });
  }
});

router.get('/admin/facility', requireWebRole('Admin'), (req, res) => {
  const actor = res.locals.actor;
  res.render('admin-facility', {
    title: 'Facility',
    actor,
    facility: getFacilityProfile(actor),
    error: null,
    saved: req.query.saved === '1',
  });
});

router.post('/admin/facility', requireWebRole('Admin'), (req, res) => {
  const actor = res.locals.actor;
  try {
    updateFacility(actor, req.body);
    res.redirect('/admin/facility?saved=1');
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('admin-facility', {
      title: 'Facility',
      actor,
      facility: getFacilityProfile(actor),
      error: message,
      saved: false,
    });
  }
});

// ---- Public invite activation --------------------------------------------

router.get('/invite/:token', (req: Request, res: Response) => {
  try {
    const invite = getValidInvite(req.params.token);
    res.render('invite', {
      title: 'Activate account',
      token: req.params.token,
      invite,
      error: null,
    });
  } catch (err) {
    const { message } = friendly(err);
    res.status(400).render('invite', { title: 'Activate account', token: req.params.token, invite: null, error: message });
  }
});

router.post('/invite/:token', (req: Request, res: Response) => {
  try {
    activateInvite(req.params.token, { name: req.body.name, password: req.body.password });
    res.render('invite-done', { title: 'Account ready' });
  } catch (err) {
    const { message } = friendly(err);
    let invite = null;
    try {
      invite = getValidInvite(req.params.token);
    } catch {
      /* token no longer valid */
    }
    res.status(400).render('invite', { title: 'Activate account', token: req.params.token, invite, error: message });
  }
});

// ---- Patients -------------------------------------------------------------

router.get('/patients/new', requireWebRole('Receptionist'), (req, res) => {
  res.render('patient-new', { title: 'Register patient', actor: res.locals.actor, error: null });
});

router.post('/patients', requireWebRole('Receptionist'), (req, res) => {
  try {
    const patient = registerPatient(res.locals.actor, req.body);
    res.redirect(`/patients/${patient.id}?registered=1`);
  } catch (err) {
    const { status, message } = friendly(err);
    res
      .status(status)
      .render('patient-new', { title: 'Register patient', actor: res.locals.actor, error: message });
  }
});

router.get('/patients', requireWebRole('Receptionist', 'Doctor'), (req, res) => {
  const q = String(req.query.q || '');
  const results = q ? searchPatients(res.locals.actor, q) : [];
  res.render('patient-search', { title: 'Find patient', actor: res.locals.actor, q, results });
});

router.get('/patients/:id', requireWebRole('Receptionist', 'Doctor'), (req, res) => {
  const actor = res.locals.actor;
  const id = Number(req.params.id);
  try {
    if (actor.activeRole === 'Doctor') {
      const summary = getPatientSummary(actor, id);
      res.render('patient-detail', {
        title: 'Patient',
        actor,
        summary,
        registered: req.query.registered === '1',
      });
    } else {
      // Receptionist: basic record, no clinical history.
      const summary = { patient: searchPatients(actor, String(id))[0] || null, history: [], canReadHistory: false };
      res.render('patient-detail', {
        title: 'Patient',
        actor,
        summary,
        registered: req.query.registered === '1',
      });
    }
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor });
  }
});

// ---- Queue ----------------------------------------------------------------

router.get('/queue', requireWebRole('Receptionist', 'Doctor'), (req, res) => {
  const entries = todaysQueue(res.locals.actor);
  res.render('queue', { title: "Today's queue", actor: res.locals.actor, entries });
});

router.post('/queue', requireWebRole('Receptionist'), (req, res) => {
  try {
    addToQueue(res.locals.actor, Number(req.body.patientId), req.body.department);
    res.redirect('/queue');
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
  }
});

// ---- Consultation ---------------------------------------------------------

router.post('/visits', requireWebRole('Doctor'), (req, res) => {
  try {
    const visit = openVisit(
      res.locals.actor,
      Number(req.body.patientId),
      req.body.queueEntryId ? Number(req.body.queueEntryId) : null
    );
    res.redirect(`/visits/${visit.id}?patientId=${visit.patientId}`);
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
  }
});

router.get('/visits/:id', requireWebRole('Doctor'), (req, res) => {
  const actor = res.locals.actor;
  const visitId = Number(req.params.id);
  // Re-derive the patient summary via the visit's patient for the form context.
  try {
    const summary = getPatientSummary(actor, Number(req.query.patientId));
    res.render('consultation', { title: 'Consultation', actor, visitId, summary });
  } catch {
    res.render('consultation', { title: 'Consultation', actor, visitId, summary: null });
  }
});

router.post('/visits/:id/finalize', requireWebRole('Doctor'), (req, res) => {
  const actor = res.locals.actor;
  try {
    const meds = parseMedications(req.body);
    const { prescription } = finalizeConsultation(actor, Number(req.params.id), {
      diagnosis: req.body.diagnosis,
      notes: req.body.notes,
      medications: meds,
    });
    if (prescription) {
      res.redirect(`/prescriptions/${prescription.id}`);
    } else {
      res.redirect('/queue');
    }
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor });
  }
});

function parseMedications(body: any): Array<{ name: string; dosage: string; instructions: string }> {
  const names = toArray(body.medName);
  const dosages = toArray(body.medDosage);
  const instr = toArray(body.medInstructions);
  const meds = [];
  for (let i = 0; i < names.length; i++) {
    if (names[i] && names[i].trim()) {
      meds.push({
        name: names[i].trim(),
        dosage: (dosages[i] || '').trim(),
        instructions: (instr[i] || '').trim(),
      });
    }
  }
  return meds;
}

function toArray(v: any): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- Prescription (printable) --------------------------------------------

import { getPrescription } from '../../core/entityStore';

router.get('/prescriptions/:id', requireWebRole('Doctor'), (req, res) => {
  const rx = getPrescription(Number(req.params.id));
  if (!rx) {
    res.status(404).render('error', { title: 'Not found', message: 'Prescription not found.', actor: res.locals.actor });
    return;
  }
  res.render('prescription', { title: 'Prescription', actor: res.locals.actor, rx });
});

// ---- Pharmacy -------------------------------------------------------------

router.get('/pharmacy/lookup', requireWebRole('Pharmacy'), (req, res) => {
  const actor = res.locals.actor;
  const token = String(req.query.token || '');
  const dispensed = req.query.dispensed === '1';
  if (!token) {
    res.render('pharmacy', { title: 'Pharmacy lookup', actor, view: null, error: null, token: '', dispensed });
    return;
  }
  try {
    const view = lookupByToken(actor, token);
    res.render('pharmacy', { title: 'Pharmacy lookup', actor, view, error: null, token, dispensed });
  } catch (err) {
    const { message } = friendly(err);
    res.render('pharmacy', { title: 'Pharmacy lookup', actor, view: null, error: message, token, dispensed });
  }
});

router.post('/pharmacy/dispense', requireWebRole('Pharmacy'), (req, res) => {
  const actor = res.locals.actor;
  try {
    recordDispensing(actor, Number(req.body.prescriptionId), req.body.itemsDispensed);
    res.redirect(`/pharmacy/lookup?token=${encodeURIComponent(req.body.token)}&dispensed=1`);
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor });
  }
});

// ---- Notifications debug view (demo aid) ----------------------------------

router.get('/notifications', requireAuth, (req, res) => {
  res.render('notifications', { title: 'Notifications', actor: res.locals.actor, jobs: listJobs() });
});

// ---- Unsubscribe (anti-spam compliance) -----------------------------------

router.get('/unsubscribe', (req: Request, res: Response) => {
  res.render('unsubscribe', { title: 'Unsubscribe', email: String(req.query.email || '') });
});
