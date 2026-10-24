import { NextFunction, Request, Response, Router } from 'express';
import { ACCOMMODATIONS, EHR_CATEGORIES, EQUIPMENT_STATUSES, ROOM_STATUSES } from '../../core/types';
import { canUseFeature } from '../../core/accessControl';
import {
  bookAppointment,
  cancelAppointment,
  listBookableDoctors,
  listDoctorAppointments,
  listPatientAppointments,
  rescheduleAppointment,
} from '../../modules/appointments/appointmentService';
import {
  getPatientBilling,
  getPharmacyBilling,
  markPharmacyChargePaid,
  setInsuranceForPatient,
} from '../../modules/billing/billingService';
import {
  getDirectory,
  getInsuranceMarketplace,
  getPublicPharmacyStock,
  Viewer,
} from '../../modules/directory/directoryService';
import {
  addEhrRecord,
  assignTechnicianToPatient,
  listEhrForPatientSelf,
  listTechnicianPatients,
} from '../../modules/ehr/ehrService';
import {
  addEquipment,
  addRoom,
  addShift,
  DAY_NAMES,
  getStaffAvailability,
  listAccommodationAvailability,
  listEquipmentFor,
  listFacilityRooms,
  removeShift,
  setAccommodation,
  updateEquipmentStatus,
  updateRoomStatus,
} from '../../modules/facilityOps/opsService';
import {
  doctorPeerGrant,
  listConsentRecords,
  patientGrantAccess,
  patientListGrants,
  patientRevokeGrant,
} from '../../modules/grants/grantService';
import { getAdminDirectory } from '../../modules/admin/adminService';
import { getPurchaseHistory, listOwnStock, saveStockItem } from '../../modules/pharmacy/pharmacyService';
import {
  getAccommodations,
  getMedicationPlan,
  getPortalPatient,
  setAccommodationNeeds,
} from '../../modules/portal/portalService';
import { listMyPatients } from '../../modules/prescription/consultationService';
import {
  completeWhoopConnect,
  getPatientWearableOverview,
  getResearchDataset,
  reidentifyResearchSubject,
  researchDatasetToCsv,
  signWearableConsent,
  startWhoopConnect,
  syncPatientWearables,
  withdrawWearableConsent,
} from '../../modules/wearables/wearableService';
import { actorFromSession, requireWebRole } from './middleware';
import { friendly } from './routes';

/**
 * Routes for the user-class feature matrix (steering: "Application
 * Requirements by User Class"). Every route is guarded by role here AND by the
 * core service it calls; the service is the source of truth.
 */
export const featureRouter = Router();

// ---- Helpers ----------------------------------------------------------------

/** Resolve the viewer: a staff session or a patient-portal session. */
function viewerFrom(req: Request): Viewer | null {
  const actor = actorFromSession(req);
  if (actor) return { kind: 'staff', actor };
  if (req.session.portalPatientId) return { kind: 'patient', patientId: req.session.portalPatientId };
  return null;
}

/** Guard for shared-baseline pages: any signed-in staff member or patient. */
function requireViewer(req: Request, res: Response, next: NextFunction): void {
  const viewer = viewerFrom(req);
  if (!viewer) {
    res.redirect('/login');
    return;
  }
  res.locals.viewer = viewer;
  if (viewer.kind === 'staff') res.locals.actor = viewer.actor;
  else res.locals.patient = getPortalPatient(viewer.patientId);
  next();
}

/** Guard for patient-portal pages. */
function requirePortal(req: Request, res: Response, next: NextFunction): void {
  const id = req.session.portalPatientId;
  if (!id) {
    res.redirect('/portal');
    return;
  }
  res.locals.patientId = id;
  res.locals.patient = getPortalPatient(id);
  next();
}

/** Render, or render the right error page for staff vs. patient. */
function renderSafe(res: Response, view: string, build: () => Record<string, unknown>): void {
  try {
    res.render(view, { ...build(), notice: res.req.query.notice ?? null });
  } catch (err) {
    const { status, message } = friendly(err);
    if (res.locals.actor) {
      res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
    } else {
      res.status(status).render('portal-error', { title: 'Error', message, patient: res.locals.patient ?? null });
    }
  }
}

/** Run a mutation then redirect back with a notice, or show a friendly error. */
function act(res: Response, back: string, notice: string, fn: () => void): void {
  try {
    fn();
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(`${back}${sep}notice=${encodeURIComponent(notice)}`);
  } catch (err) {
    const { status, message } = friendly(err);
    if (res.locals.actor) {
      res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
    } else {
      res.status(status).render('portal-error', { title: 'Error', message, patient: res.locals.patient ?? null });
    }
  }
}

/** Async variant of act(): for mutations that call an external API. */
async function actAsync(res: Response, back: string, fn: () => Promise<string>): Promise<void> {
  try {
    const notice = await fn();
    const sep = back.includes('?') ? '&' : '?';
    res.redirect(`${back}${sep}notice=${encodeURIComponent(notice)}`);
  } catch (err) {
    const { status, message } = friendly(err);
    if (res.locals.actor) {
      res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
    } else {
      res.status(status).render('portal-error', { title: 'Error', message, patient: res.locals.patient ?? null });
    }
  }
}

// ---- Shared baseline (ALL users) ---------------------------------------------

featureRouter.get('/directory', requireViewer, (req, res) => {
  const viewer = res.locals.viewer as Viewer;
  renderSafe(res, 'directory', () => ({ title: 'Hospitals & pharmacies', facilities: getDirectory(viewer) }));
});

featureRouter.get('/insurance-plans', requireViewer, (req, res) => {
  const viewer = res.locals.viewer as Viewer;
  renderSafe(res, 'insurance-plans', () => ({ title: 'Insurance marketplace', plans: getInsuranceMarketplace(viewer) }));
});

featureRouter.get('/medicines', requireViewer, (req, res) => {
  const viewer = res.locals.viewer as Viewer;
  const q = String(req.query.q || '');
  renderSafe(res, 'medicines', () => ({
    title: 'Medicines & prices',
    q,
    rows: getPublicPharmacyStock(viewer, q),
  }));
});

// ---- Patient portal ----------------------------------------------------------

featureRouter.get('/portal/appointments', requirePortal, (req, res) => {
  const patientId = res.locals.patientId as number;
  renderSafe(res, 'portal-appointments', () => ({
    title: 'Appointments',
    appointments: listPatientAppointments(patientId),
    doctors: listBookableDoctors(),
  }));
});

featureRouter.post('/portal/appointments', requirePortal, (req, res) => {
  act(res, '/portal/appointments', 'Appointment booked.', () =>
    bookAppointment(res.locals.patientId, req.body)
  );
});

featureRouter.post('/portal/appointments/:id/reschedule', requirePortal, (req, res) => {
  act(res, '/portal/appointments', 'Appointment rescheduled.', () =>
    rescheduleAppointment(res.locals.patientId, Number(req.params.id), req.body.scheduledAt)
  );
});

featureRouter.post('/portal/appointments/:id/cancel', requirePortal, (req, res) => {
  act(res, '/portal/appointments', 'Appointment cancelled.', () =>
    cancelAppointment(res.locals.patientId, Number(req.params.id))
  );
});

featureRouter.get('/portal/medications', requirePortal, (req, res) => {
  renderSafe(res, 'portal-medications', () => ({
    title: 'My medicines',
    plan: getMedicationPlan(res.locals.patientId),
  }));
});

featureRouter.get('/portal/billing', requirePortal, (req, res) => {
  renderSafe(res, 'portal-billing', () => ({
    title: 'Bills & costs',
    billing: getPatientBilling(res.locals.patientId),
  }));
});

featureRouter.get('/portal/health-record', requirePortal, (req, res) => {
  renderSafe(res, 'portal-ehr', () => ({
    title: 'My health record',
    records: listEhrForPatientSelf(res.locals.patientId),
  }));
});

featureRouter.get('/portal/accommodations', requirePortal, (req, res) => {
  renderSafe(res, 'portal-accommodations', () => ({
    title: 'Accommodations',
    view: getAccommodations(res.locals.patientId),
  }));
});

featureRouter.post('/portal/accommodations', requirePortal, (req, res) => {
  act(res, '/portal/accommodations', 'Your accommodation needs were saved.', () =>
    setAccommodationNeeds(res.locals.patientId, req.body.needs)
  );
});

featureRouter.get('/portal/access', requirePortal, (req, res) => {
  renderSafe(res, 'portal-access', () => ({
    title: 'Who can see my records',
    grants: patientListGrants(res.locals.patientId),
    doctors: listBookableDoctors(),
  }));
});

featureRouter.post('/portal/access', requirePortal, (req, res) => {
  act(res, '/portal/access', 'Access granted.', () =>
    patientGrantAccess(res.locals.patientId, req.body.doctorId, req.body.days)
  );
});

featureRouter.post('/portal/access/:id/revoke', requirePortal, (req, res) => {
  act(res, '/portal/access', 'Access revoked.', () =>
    patientRevokeGrant(res.locals.patientId, Number(req.params.id))
  );
});

// ---- Patient portal: wearables (WHOOP) ---------------------------------------

featureRouter.get('/portal/wearables', requirePortal, (req, res) => {
  renderSafe(res, 'portal-wearables', () => ({
    title: 'Wearable data',
    view: getPatientWearableOverview(res.locals.patientId),
  }));
});

featureRouter.post('/portal/wearables/consent', requirePortal, (req, res) => {
  act(res, '/portal/wearables', 'Consent signed. You can now connect your WHOOP.', () =>
    signWearableConsent(res.locals.patientId, req.body)
  );
});

featureRouter.post('/portal/wearables/connect', requirePortal, async (req, res) => {
  try {
    const result = await startWhoopConnect(res.locals.patientId);
    if (result.kind === 'redirect') {
      // Hand off to WHOOP's own authorization screen; the callback finishes.
      req.session.whoopOAuthState = result.state;
      res.redirect(result.url);
      return;
    }
    res.redirect(
      `/portal/wearables?notice=${encodeURIComponent(`Demo WHOOP connected. ${result.synced} day(s) of data synced.`)}`
    );
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('portal-error', { title: 'Error', message, patient: res.locals.patient ?? null });
  }
});

featureRouter.get('/portal/wearables/whoop/callback', requirePortal, (req, res) => {
  const expected = req.session.whoopOAuthState;
  delete req.session.whoopOAuthState; // single use
  void actAsync(res, '/portal/wearables', async () => {
    const synced = await completeWhoopConnect(res.locals.patientId, req.query, expected);
    return `WHOOP connected. ${synced} day(s) of data synced.`;
  });
});

featureRouter.post('/portal/wearables/sync', requirePortal, (req, res) => {
  void actAsync(res, '/portal/wearables', async () => {
    const synced = await syncPatientWearables(res.locals.patientId);
    return `Synced ${synced} day(s) of wearable data.`;
  });
});

featureRouter.post('/portal/wearables/withdraw', requirePortal, (req, res) => {
  act(res, '/portal/wearables', 'Consent withdrawn. Your wearable data and its link to you were deleted.', () =>
    withdrawWearableConsent(res.locals.patientId)
  );
});

// ---- Doctor ------------------------------------------------------------------

featureRouter.get('/doctor/appointments', requireWebRole('Doctor'), (req, res) => {
  renderSafe(res, 'doctor-appointments', () => ({
    title: 'My appointments',
    actor: res.locals.actor,
    appts: listDoctorAppointments(res.locals.actor),
  }));
});

featureRouter.get('/doctor/patients', requireWebRole('Doctor'), (req, res) => {
  renderSafe(res, 'doctor-patients', () => ({
    title: 'My patients',
    actor: res.locals.actor,
    rows: listMyPatients(res.locals.actor),
  }));
});

// De-identified wearable research dataset (ML) + controlled re-identification.
featureRouter.get('/research/wearables', requireWebRole('Doctor'), (req, res) => {
  renderSafe(res, 'research-wearables', () => {
    const data = getResearchDataset(res.locals.actor);
    return {
      title: 'Wearable research data',
      actor: res.locals.actor,
      subjects: data.subjects,
      totalRows: data.rows.length,
      rows: data.rows.slice(0, 100),
    };
  });
});

featureRouter.get('/research/wearables.csv', requireWebRole('Doctor'), (req, res) => {
  try {
    const csv = researchDatasetToCsv(getResearchDataset(res.locals.actor).rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wearable-research-deidentified.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
  }
});

featureRouter.post('/research/wearables/reidentify', requireWebRole('Doctor'), (req, res) => {
  try {
    const patientId = reidentifyResearchSubject(res.locals.actor, req.body.pseudonym, req.body.reason);
    res.redirect(`/patients/${patientId}?notice=${encodeURIComponent('Research code matched a patient under your care. This lookup was recorded.')}`);
  } catch (err) {
    const { status, message } = friendly(err);
    res.status(status).render('error', { title: 'Error', message, actor: res.locals.actor });
  }
});

featureRouter.post('/patients/:id/ehr', requireWebRole('Doctor'), (req, res) => {
  const id = Number(req.params.id);
  act(res, `/patients/${id}`, 'Health record entry added.', () => addEhrRecord(res.locals.actor, id, req.body));
});

featureRouter.post('/patients/:id/assign-technician', requireWebRole('Doctor'), (req, res) => {
  const id = Number(req.params.id);
  act(res, `/patients/${id}`, 'Technician assigned.', () =>
    assignTechnicianToPatient(res.locals.actor, id, Number(req.body.technicianId))
  );
});

featureRouter.post('/patients/:id/peer-grant', requireWebRole('Doctor'), (req, res) => {
  const id = Number(req.params.id);
  act(res, `/patients/${id}`, 'Access shared with the doctor.', () =>
    doctorPeerGrant(res.locals.actor, id, req.body.doctorId, req.body.days)
  );
});

// ---- Receptionist ------------------------------------------------------------

featureRouter.post('/patients/:id/insurance', requireWebRole('Receptionist'), (req, res) => {
  const id = Number(req.params.id);
  act(res, `/patients/${id}`, 'Insurance saved.', () => setInsuranceForPatient(res.locals.actor, id, req.body));
});

// ---- Equipment (Admin / Doctor / Technician) --------------------------------

featureRouter.get('/equipment', requireWebRole('Admin', 'Doctor', 'Technician'), (req, res) => {
  const actor = res.locals.actor;
  renderSafe(res, 'equipment', () => ({
    title: 'Equipment status',
    actor,
    items: listEquipmentFor(actor),
    canManage: canUseFeature(actor, 'equipment.manage'),
    categories: EHR_CATEGORIES,
    statuses: EQUIPMENT_STATUSES,
  }));
});

featureRouter.post('/equipment', requireWebRole('Admin'), (req, res) => {
  act(res, '/equipment', 'Equipment added.', () => addEquipment(res.locals.actor, req.body));
});

featureRouter.post('/equipment/:id/status', requireWebRole('Admin'), (req, res) => {
  act(res, '/equipment', 'Status updated.', () =>
    updateEquipmentStatus(res.locals.actor, Number(req.params.id), req.body.status)
  );
});

// ---- Technician --------------------------------------------------------------

featureRouter.get('/technician/ehr', requireWebRole('Technician'), (req, res) => {
  renderSafe(res, 'technician-ehr', () => ({
    title: 'Specialty records',
    actor: res.locals.actor,
    patients: listTechnicianPatients(res.locals.actor),
  }));
});

// ---- Pharmacy ----------------------------------------------------------------

featureRouter.get('/pharmacy/stock', requireWebRole('Pharmacy'), (req, res) => {
  renderSafe(res, 'pharmacy-stock', () => ({
    title: 'Stock & pricing',
    actor: res.locals.actor,
    stock: listOwnStock(res.locals.actor),
  }));
});

featureRouter.post('/pharmacy/stock', requireWebRole('Pharmacy'), (req, res) => {
  act(res, '/pharmacy/stock', 'Stock saved.', () => saveStockItem(res.locals.actor, req.body));
});

featureRouter.get('/pharmacy/purchases', requireWebRole('Pharmacy'), (req, res) => {
  renderSafe(res, 'pharmacy-purchases', () => ({
    title: 'Purchase history',
    actor: res.locals.actor,
    rows: getPurchaseHistory(res.locals.actor),
  }));
});

featureRouter.get('/pharmacy/billing', requireWebRole('Pharmacy'), (req, res) => {
  renderSafe(res, 'pharmacy-billing', () => ({
    title: 'Billing records',
    actor: res.locals.actor,
    billing: getPharmacyBilling(res.locals.actor),
  }));
});

featureRouter.post('/pharmacy/billing/:id/paid', requireWebRole('Pharmacy'), (req, res) => {
  act(res, '/pharmacy/billing', 'Marked as paid.', () =>
    markPharmacyChargePaid(res.locals.actor, Number(req.params.id))
  );
});

// ---- Admin (hospital operations) ---------------------------------------------

featureRouter.get('/admin/rooms', requireWebRole('Admin'), (req, res) => {
  renderSafe(res, 'admin-rooms', () => ({
    title: 'Rooms',
    actor: res.locals.actor,
    rooms: listFacilityRooms(res.locals.actor),
    statuses: ROOM_STATUSES,
  }));
});

featureRouter.post('/admin/rooms', requireWebRole('Admin'), (req, res) => {
  act(res, '/admin/rooms', 'Room added.', () => addRoom(res.locals.actor, req.body));
});

featureRouter.post('/admin/rooms/:id/status', requireWebRole('Admin'), (req, res) => {
  act(res, '/admin/rooms', 'Room updated.', () =>
    updateRoomStatus(res.locals.actor, Number(req.params.id), req.body.status)
  );
});

featureRouter.get('/admin/availability', requireWebRole('Admin'), (req, res) => {
  renderSafe(res, 'admin-availability', () => ({
    title: 'Staff availability',
    actor: res.locals.actor,
    rows: getStaffAvailability(res.locals.actor),
    days: DAY_NAMES,
  }));
});

featureRouter.post('/admin/availability', requireWebRole('Admin'), (req, res) => {
  act(res, '/admin/availability', 'Shift added.', () => addShift(res.locals.actor, req.body));
});

featureRouter.post('/admin/availability/:id/delete', requireWebRole('Admin'), (req, res) => {
  act(res, '/admin/availability', 'Shift removed.', () => removeShift(res.locals.actor, Number(req.params.id)));
});

featureRouter.get('/admin/accommodations', requireWebRole('Admin'), (req, res) => {
  renderSafe(res, 'admin-accommodations', () => ({
    title: 'Accommodations',
    actor: res.locals.actor,
    rows: listAccommodationAvailability(res.locals.actor),
    options: ACCOMMODATIONS,
  }));
});

featureRouter.post('/admin/accommodations', requireWebRole('Admin'), (req, res) => {
  act(res, '/admin/accommodations', 'Accommodation saved.', () => setAccommodation(res.locals.actor, req.body));
});

featureRouter.get('/admin/consent', requireWebRole('Admin'), (req, res) => {
  renderSafe(res, 'admin-consent', () => ({
    title: 'Consent records',
    actor: res.locals.actor,
    records: listConsentRecords(res.locals.actor),
  }));
});

featureRouter.get('/admin/directory', requireWebRole('Admin'), (req, res) => {
  renderSafe(res, 'admin-directory', () => ({
    title: 'Directory',
    actor: res.locals.actor,
    dir: getAdminDirectory(res.locals.actor),
  }));
});
