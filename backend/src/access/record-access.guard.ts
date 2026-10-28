import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { AccessService } from './access.service';

const DOSSIER_PATH = /^\/api\/dossiers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/|\?|$)/i;
const ITEM_PATH = /^\/api\/records\/(?:drafts\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/|\?|$)/i;

/**
 * Applies the record-level evaluator to every route that names one dossier or
 * one record, before the route runs — reads and changes alike, the Delivery 1
 * routes included. One place, so no route can forget it.
 *
 * It only acts once a session exists. A request without one passes through to
 * the route's own guard, which answers 401 exactly as before.
 */
@Injectable()
export class RecordAccessGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const accountId = request.session?.accountId;
    if (!accountId) return true;
    const path = request.originalUrl ?? request.url ?? '';
    const dossier = DOSSIER_PATH.exec(path);
    if (dossier) {
      const profile = await this.access.profile(accountId);
      // Administration confers no content; the route's role check answers it.
      if (!profile.business) return true;
      if (!(await this.access.canViewDossier(profile, dossier[1]))) throw new NotFoundException('Unknown dossier.');
      return true;
    }
    const item = ITEM_PATH.exec(path);
    if (item) {
      const profile = await this.access.profile(accountId);
      if (!profile.business) return true;
      if (!(await this.access.canViewItem(profile, item[1]))) throw new NotFoundException('Unknown item.');
    }
    return true;
  }
}
