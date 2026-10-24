import { recordAudit } from '../../core/audit';
import { AccessDenied, requireRole } from '../../core/accessControl';
import {
  getLabTest,
  getVisit,
  getVisitByAccessCode,
  listLabTestsForVisit,
  recordLabTestResult,
} from '../../core/entityStore';
import { Actor, LabTest } from '../../core/types';
import { requireText, ValidationError } from '../../core/validation';

/**
 * Technician (lab) module. A technician looks up a visit by its receipt access
 * code and sees ONLY that visit's recommended tests — never the diagnosis,
 * clinical notes, or any other patient data. They record a result (text, with
 * an optional attachment) and the test moves to Done. All writes are audited.
 */

export interface TechnicianVisitView {
  visitId: number;
  accessCode: string;
  tests: LabTest[];
}

/**
 * Look up a visit's tests by its access code. Deliberately returns no patient
 * identity, diagnosis, or notes — the technician's scope is the tests only.
 */
export function lookupTestsByCode(actor: Actor, code: string): TechnicianVisitView {
  requireRole(actor, 'Technician');
  const trimmed = requireText(code, 'Receipt code');
  const visit = getVisitByAccessCode(trimmed);
  if (!visit || visit.facilityCode !== actor.facilityCode) {
    // Non-leaking: same error whether the code is unknown or belongs elsewhere.
    throw new AccessDenied('No tests were found for that code.');
  }
  return {
    visitId: visit.id,
    accessCode: visit.accessCode,
    tests: listLabTestsForVisit(visit.id),
  };
}

export function recordResult(
  actor: Actor,
  testId: number,
  input: { result: string; resultAttachmentId: number | null }
): LabTest {
  requireRole(actor, 'Technician');
  const test = getLabTest(testId);
  if (!test) throw new AccessDenied('That test could not be found.');

  // Confirm the test belongs to a visit at the technician's facility.
  const visit = getVisit(test.visitId);
  if (!visit || visit.facilityCode !== actor.facilityCode) {
    throw new AccessDenied('That test could not be found.');
  }

  if (test.status === 'Done') {
    throw new ValidationError('A result has already been recorded for this test.');
  }
  const result = requireText(input.result, 'Result');

  recordLabTestResult(testId, result, input.resultAttachmentId);
  recordAudit({
    actor,
    action: 'test_result',
    entity: 'lab_test',
    entityId: testId,
    detail: `Result recorded for ${test.testName}`,
  });
  return getLabTest(testId)!;
}
