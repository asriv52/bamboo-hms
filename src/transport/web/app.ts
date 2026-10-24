import path from 'path';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { config } from '../../core/config';
import { router } from './routes';

/**
 * Web transport module. Wires Express, sessions, views, and routes. It calls
 * core/domain services only — it never touches the database directly.
 */
export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

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

  return app;
}
