import { requireRole } from '../../core/accessControl';
import { todayUtcDatePrefix } from '../../core/db';
import {
  countRegisteredTodayByDepartment,
  countQueueTodayByDepartment,
  countVisitsFinalizedTodayByDepartment,
  getFacility,
} from '../../core/entityStore';
import { Actor } from '../../core/types';

/**
 * Admin dashboard. Aggregate counts ONLY, broken down per department, scoped to
 * the admin's facility. Contains no patient names, emails, IDs, or any other
 * patient-identifying data — only department labels and numbers.
 */
export interface DepartmentRow {
  department: string;
  registeredToday: number;
  inQueue: number;
  visitsCompleted: number;
}

export interface DashboardStats {
  facilityCode: string;
  departments: DepartmentRow[];
  totals: { registeredToday: number; inQueue: number; visitsCompleted: number };
}

export function getDashboard(actor: Actor): DashboardStats {
  requireRole(actor, 'Admin');
  const day = todayUtcDatePrefix();
  const facility = getFacility(actor.facilityCode);

  const registered = countRegisteredTodayByDepartment(actor.facilityCode, day);
  const waiting = countQueueTodayByDepartment(actor.facilityCode, day, 'Waiting');
  const completed = countVisitsFinalizedTodayByDepartment(actor.facilityCode, day);

  // Union of all department names that appear anywhere, plus the facility's
  // declared departments, so empty departments still show a zero row.
  const names = new Set<string>([
    ...(facility?.departments ?? []),
    ...Object.keys(registered),
    ...Object.keys(waiting),
    ...Object.keys(completed),
  ]);

  const departments: DepartmentRow[] = [...names]
    .sort()
    .map((department) => ({
      department,
      registeredToday: registered[department] ?? 0,
      inQueue: waiting[department] ?? 0,
      visitsCompleted: completed[department] ?? 0,
    }));

  const totals = departments.reduce(
    (acc, d) => ({
      registeredToday: acc.registeredToday + d.registeredToday,
      inQueue: acc.inQueue + d.inQueue,
      visitsCompleted: acc.visitsCompleted + d.visitsCompleted,
    }),
    { registeredToday: 0, inQueue: 0, visitsCompleted: 0 }
  );

  return { facilityCode: actor.facilityCode, departments, totals };
}
