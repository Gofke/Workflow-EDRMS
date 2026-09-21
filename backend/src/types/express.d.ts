import { AuthenticatedUser } from '../auth/dto';
import { RepresentedAuthority } from '../delegation/delegation.service';

// Session and request typing for the authenticated identity.
declare module 'express-session' {
  interface SessionData {
    accountId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedUser;
      /** Set only when authority came from a delegation (FR-DEL-003). */
      representedAuthority?: RepresentedAuthority;
    }
  }
}
