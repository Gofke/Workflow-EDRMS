import 'reflect-metadata';
import dotenv from 'dotenv';
import { DataSource, LogLevel } from 'typeorm';
import { Account } from '../identity/account.entity';
import { FunctionalRole } from '../identity/functional-role.entity';
import { OrganisationalUnit } from '../identity/organisational-unit.entity';
import { Person } from '../identity/person.entity';
import { AuditEvent } from '../audit/audit-event.entity';
import { CorrespondenceItem } from '../records/correspondence-item.entity';
import { Dossier, DossierLink, DossierStateEvent } from '../records/dossier.entity';
import { DueDateChange, ResponsibilityAssignment } from '../records/responsibility.entity';
import { CapturedDocument } from '../documents/captured-document.entity';
import { DocumentText } from '../documents/document-text.entity';
import { Delegation } from '../delegation/delegation.entity';
import { WorkflowEvent } from '../workflow/workflow.entity';
import { RoleAssignment } from '../identity/role-assignment.entity';
import { InitIdentity1758100000000 } from '../migrations/1758100000000-InitIdentity';
import { AuditAndRoleAdmin1758200000000 } from '../migrations/1758200000000-AuditAndRoleAdmin';
import { Records1758300000000 } from '../migrations/1758300000000-Records';
import { Dossiers1758400000000 } from '../migrations/1758400000000-Dossiers';
import { Responsibility1758500000000 } from '../migrations/1758500000000-Responsibility';
import { CapturedDocuments1758600000000 } from '../migrations/1758600000000-CapturedDocuments';
import { Delegation1758700000000 } from '../migrations/1758700000000-Delegation';
import { Workflow1758800000000 } from '../migrations/1758800000000-Workflow';
import { Finalisation1758900000000 } from '../migrations/1758900000000-Finalisation';
import { DossierClosure1759000000000 } from '../migrations/1759000000000-DossierClosure';
import { DuplicateLookup1759100000000 } from '../migrations/1759100000000-DuplicateLookup';
import { DocumentText1759200000000 } from '../migrations/1759200000000-DocumentText';

dotenv.config();

export const dataSourceOptions = {
  type: 'postgres' as const,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities: [Person, Account, FunctionalRole, RoleAssignment, OrganisationalUnit, AuditEvent, CorrespondenceItem,
    Dossier,
    DossierLink,
    DossierStateEvent,
    ResponsibilityAssignment,
    DueDateChange,
    CapturedDocument,
    DocumentText,
    Delegation,
    WorkflowEvent,
  ],
  migrations: [
    InitIdentity1758100000000,
    AuditAndRoleAdmin1758200000000,
    Records1758300000000,
    Dossiers1758400000000,
    Responsibility1758500000000,
    CapturedDocuments1758600000000,
    Delegation1758700000000,
    Workflow1758800000000,
    Finalisation1758900000000,
    DossierClosure1759000000000,
    DuplicateLookup1759100000000,
    DocumentText1759200000000,
  ],
  // Never true. The schema changes only through a reviewed migration.
  synchronize: false,
  // Silent under test: the integrity specs deliberately provoke constraint and
  // trigger errors, and logging each one buries the actual test output.
  logging: (process.env.NODE_ENV === 'test'
    ? []
    : process.env.NODE_ENV === 'development'
      ? ['error', 'warn']
      : ['error']) as LogLevel[],
};

export const AppDataSource = new DataSource(dataSourceOptions);
