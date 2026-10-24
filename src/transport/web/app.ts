import path from 'path';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { config } from '../../core/config';
import { formatCents } from '../../core/billingCore';
import { TECHNICIAN_SPECIALTIES } from '../../core/types';
import { router } from './routes';
import { featureRouter } from './featureRoutes';

/**
 * Web transport module. Wires Express, sessions, views, and routes. It calls
 * core/domain services only — it never touches the database directly.
 */
export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // View helpers. All times are stored in UTC and shown as UTC in this build.
  app.locals.money = formatCents;
  app.locals.specialties = TECHNICIAN_SPECIALTIES;
  app.locals.utc = (iso: string | null | undefined) =>
    iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—';

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );

  // Expose a dev-mailbox flag to all views so the nav can show the Mailbox link
  // only outside production (where the /mailbox route is not mounted).
  const devMailbox = process.env.NODE_ENV !== 'production';
  app.use((_req, res, next) => {
    res.locals.devMailbox = devMailbox;
    next();
  });

  app.use(router);
  app.use(featureRouter);

  return app;
}
