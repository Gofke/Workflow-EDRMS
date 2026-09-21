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
import { RequireRoles } from '../auth/require-roles.decorator';
import { Actor } from '../records/registration.service';
import { CapturedDocumentView, DocumentsService, DocumentTextView } from './documents.service';

/**
 * Capture and retrieval of document content.
 *
 * The same registering roles as the registry itself. SYS_ADMIN is absent:
 * administrative power confers no access to record content (FR-SEC-010), and
 * the content is the most sensitive part of a record.
 */
const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/records/:itemId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

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
  text(@Param('documentId') documentId: string): Promise<DocumentTextView> {
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
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { bytes, filename, mediaType } = await this.documents.retrieve(
      actorFrom(request),
      documentId,
    );
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
}

function actorFrom(request: Request): Actor {
  const user = request.authenticatedUser;
  return {
    accountId: user?.accountId as string,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
  };
}
