import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CorrespondenceItem } from '../records/correspondence-item.entity';
import { CapturedDocument } from './captured-document.entity';
import { DocumentText } from './document-text.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CapturedDocument, DocumentText, CorrespondenceItem]),
    AuthModule,
    AuditModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
