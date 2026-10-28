import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { RequireRoles } from '../auth/require-roles.decorator';
import { Actor } from '../records/registration.service';
import { CapturedDocumentView, DocumentsService, DocumentTextView } from './documents.service';

/**
 * Capture and retrieval of document content.
 *
 * The same registering roles as the registry itself. SYS_ADMIN is absent:
 * administrative power confers no access to record content (FR-SEC-010), and
 * the content is the most sensitive part of a record.
 *
 * V0.3.0: every route checks that the document belongs to the record in the
 * address — the record-level evaluator checks the record, and this makes sure
 * the record it checked is the one the document comes from. Opening a
 * document is written to the view log.
 */
const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];

/** Types a browser may show inline. Everything else is offered as a download. */
const PREVIEWABLE = ['application/pdf', 'image/jpeg', 'image/png'];

@Controller('api/records/:itemId/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @RequireRoles(...REGISTRARS)
  list(@Param('itemId') itemId: string): Promise<CapturedDocumentView[]> {
    return this.documents.listFor(itemId);
  }

  /**
   * FR-COR-015: the text read from a document, where OCR is enabled. Always
   * marked derived; the authoritative content is at /content and unchanged.
   */
  @Get(':documentId/text')
  @RequireRoles(...REGISTRARS)
  async text(@Param('itemId') itemId: string, @Param('documentId') documentId: string): Promise<DocumentTextView> {
    await this.documents.assertBelongs(documentId, itemId);
    return this.documents.textFor(documentId);
  }

  @Post()
  @RequireRoles(...REGISTRARS)
  @UseInterceptors(FileInterceptor('file'))
  capture(
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() request: Request,
  ): Promise<CapturedDocumentView> {
    return this.documents.capture(actorFrom(request), itemId, file);
  }

  /**
   * Returns the bytes as they were captured. Content-Disposition is attachment
   * and the media type is the one recorded at capture, so nothing re-renders or
   * reinterprets the authoritative content on the way out.
   */
  @Get(':documentId/content')
  @RequireRoles(...REGISTRARS)
  async retrieve(
    @Param('itemId') itemId: string,
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.documents.assertBelongs(documentId, itemId);
    const { bytes, filename, mediaType } = await this.documents.retrieve(
      actorFrom(request),
      documentId,
    );
    await this.access.recordView(request.authenticatedUser!.accountId, 'DOCUMENT', documentId, filename, 'DOWNLOADED');
    response.setHeader('Content-Type', mediaType);
    response.setHeader('Content-Length', bytes.length);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"`,
    );
    // Downloaded content must never be executed or framed by a browser.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.end(bytes);
  }

  /**
   * V0.3.0 — the same verified bytes for viewing in the browser. Only PDFs and
   * plain images; the screen renders a PDF itself (pdf.js), so no document is
   * ever handed to a plug-in. Audited and logged exactly like a download.
   */
  @Get(':documentId/preview')
  @RequireRoles(...REGISTRARS)
  async preview(
    @Param('itemId') itemId: string,
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.documents.assertBelongs(documentId, itemId);
    const { bytes, filename, mediaType } = await this.documents.retrieve(actorFrom(request), documentId);
    await this.access.recordView(request.authenticatedUser!.accountId, 'DOCUMENT', documentId, filename, 'PREVIEWED');
    if (!PREVIEWABLE.includes(mediaType)) {
      response.status(415).json({ statusCode: 415, message: 'This type of document cannot be shown here. Download it instead.' });
      return;
    }
    response.setHeader('Content-Type', mediaType);
    response.setHeader('Content-Length', bytes.length);
    response.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    response.setHeader('Cache-Control', 'private, no-store');
    response.end(bytes);
  }

  /** V0.3.0 — re-reads the stored bytes and compares them with the fingerprint. */
  @Get(':documentId/verify')
  @RequireRoles(...REGISTRARS, 'AUDITOR')
  async verify(@Param('itemId') itemId: string, @Param('documentId') documentId: string) {
    await this.documents.assertBelongs(documentId, itemId);
    return this.documents.verify(documentId);
  }
}

function actorFrom(request: Request): Actor {
  const user = request.authenticatedUser;
  return {
    accountId: user?.accountId as string,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
  };
}
