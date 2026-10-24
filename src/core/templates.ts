import { config } from './config';

/**
 * File-free template system. Templates are named functions that take a typed
 * payload and return subject + text + html. Business logic never builds email
 * HTML inline — it names a template and passes data.
 *
 * Every patient email includes an unsubscribe link (anti-spam requirement).
 */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function unsubscribeLink(email: string): string {
  const url = `${config.publicBaseUrl}/unsubscribe?email=${encodeURIComponent(email)}`;
  return url;
}

function wrap(bodyText: string, bodyHtml: string, toEmail: string): RenderedEmail & { subject: string } {
  const unsub = unsubscribeLink(toEmail);
  return {
    subject: '', // set by caller
    text: `${bodyText}\n\n— Bamboo HMS\nYou can opt out here: ${unsub}`,
    html: `${bodyHtml}<p style="color:#0a7d6b;font-weight:700">Bamboo HMS</p><hr/><p style="font-size:12px;color:#888">You can <a href="${unsub}">opt out of these emails</a>.</p>`,
  };
}

export type TemplateName =
  | 'registration_confirmation'
  | 'visit_summary'
  | 'prescription_issued'
  | 'staff_invite'
  | 'access_otp';

export function render(
  template: TemplateName,
  toEmail: string,
  payload: Record<string, any>
): RenderedEmail {
  switch (template) {
    case 'registration_confirmation': {
      const r = wrap(
        `Hello ${payload.name}, you have been registered at ${payload.facility}. ` +
          `Your patient ID is ${payload.patientId}. Keep this for your visits.`,
        `<p>Hello ${payload.name},</p><p>You have been registered at <b>${payload.facility}</b>.</p>` +
          `<p>Your patient ID is <b>${payload.patientId}</b>. Keep this for your visits.</p>`,
        toEmail
      );
      return { ...r, subject: 'Your clinic registration is confirmed' };
    }
    case 'visit_summary': {
      const r = wrap(
        `Hello ${payload.name}, your visit on ${payload.date} is complete. ` +
          `Diagnosis: ${payload.diagnosis}. Notes: ${payload.notes}.`,
        `<p>Hello ${payload.name},</p><p>Your visit on ${payload.date} is complete.</p>` +
          `<p><b>Diagnosis:</b> ${payload.diagnosis}</p><p><b>Notes:</b> ${payload.notes}</p>`,
        toEmail
      );
      return { ...r, subject: 'Your visit summary' };
    }
    case 'prescription_issued': {
      const meds = (payload.medications as any[])
        .map((m) => `${m.name} (${m.dosage}) — ${m.instructions}`)
        .join('; ');
      const lookup = `${config.publicBaseUrl}/pharmacy/lookup?token=${payload.token}`;
      const r = wrap(
        `Hello ${payload.name}, a prescription was issued for you: ${meds}. ` +
          `Show this link to your pharmacy: ${lookup}`,
        `<p>Hello ${payload.name},</p><p>A prescription was issued for you:</p><p>${meds}</p>` +
          `<p>Show this link at your pharmacy: <a href="${lookup}">${lookup}</a></p>`,
        toEmail
      );
      return { ...r, subject: 'A prescription was issued for you' };
    }
    case 'access_otp': {
      const portal = `${config.publicBaseUrl}/portal`;
      const r = wrap(
        `Your one-time access code is ${payload.code}. ` +
          `It expires in ${payload.minutes} minutes. Enter it at ${portal} to view your records. ` +
          `If you did not request this, you can ignore this email.`,
        `<p>Your one-time access code is:</p>` +
          `<p style="font-size:24px;font-weight:700;letter-spacing:3px">${payload.code}</p>` +
          `<p>It expires in <b>${payload.minutes} minutes</b>. ` +
          `Enter it at <a href="${portal}">your records portal</a> to view your visit history.</p>` +
          `<p style="color:#888;font-size:12px">If you did not request this, you can safely ignore this email.</p>`,
        toEmail
      );
      return { ...r, subject: 'Your one-time access code' };
    }
    case 'staff_invite': {
      const link = `${config.publicBaseUrl}/invite/${payload.token}`;
      const r = wrap(
        `You have been invited to join ${payload.facility} as ${payload.roles} ` +
          `in the ${payload.department} department. Activate your account here: ${link}`,
        `<p>You have been invited to join <b>${payload.facility}</b> as <b>${payload.roles}</b> ` +
          `in the <b>${payload.department}</b> department.</p>` +
          `<p><a href="${link}">Activate your account</a> and set your password.</p>`,
        toEmail
      );
      return { ...r, subject: `You're invited to join ${payload.facility}` };
    }
    default:
      throw new Error(`Unknown email template: ${template}`);
  }
}
