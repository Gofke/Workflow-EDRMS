import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from '../config/data-source';
import { Account } from '../identity/account.entity';
import { FunctionalRole } from '../identity/functional-role.entity';
import { OrganisationalUnit } from '../identity/organisational-unit.entity';
import { Person } from '../identity/person.entity';
import { RoleAssignment } from '../identity/role-assignment.entity';
import { hashPassword } from '../auth/password';

dotenv.config();

/**
 * Seeds the Delivery 1 pilot actors from FS-01 §3 and the FS-02 role profiles.
 *
 * TEST DATA ONLY. Every account shares one password from SEED_PASSWORD, which is
 * acceptable for a pilot test environment and must never be used with real
 * ministry information. The accounts are named SYN-* to match the synthetic
 * identifiers used throughout the TS pack.
 *
 * Re-running the script is safe: existing rows are left as they are.
 */

export const ROLES = [
  { code: 'MINISTER', name: 'Minister', description: 'Senior decision-maker. Oversight, review and sign-off within ministerial authority. Title alone grants no access to restricted records.' },
  { code: 'DIRECTEUR', name: 'Directeur', description: 'Senior operational owner. Assigns responsibility, confirms due dates, reviews and approves within configured scope.' },
  { code: 'ONDER_DIRECTEUR', name: 'Onder-Directeur', description: 'Delegated operational owner. Progresses delegated matters; approval authority remains explicit, never inherited.' },
  { code: 'SUPPORT_STAFF', name: 'Assistant / support staff', description: 'Operational support. Registers and prepares work. No approval or sign-off authority by default.' },
  { code: 'SYS_ADMIN', name: 'Pilot System Administrator', description: 'Manages accounts, role assignments and configuration. Confers no unrestricted access to business-record content.' },
];

export const UNITS = [
  { code: 'HO-KAB', name: 'Head Office — Kabinet van de Minister' },
  { code: 'HO-DIR', name: 'Head Office — Directoraat' },
  { code: 'HO-ICT', name: 'Head Office — ICT en Beheer' },
];

export const USERS = [
  { ref: 'SYN-MIN-01', email: 'minister@juspol.test', fullName: 'R. Dijkstra', jobPosition: 'Minister of Justice and Police', unit: 'HO-KAB', roles: ['MINISTER'] },
  { ref: 'SYN-DIR-01', email: 'directeur@juspol.test', fullName: 'M. Sardjoe', jobPosition: 'Directeur', unit: 'HO-DIR', roles: ['DIRECTEUR'] },
  { ref: 'SYN-ODIR-01', email: 'onderdirecteur@juspol.test', fullName: 'A. Boldewijn', jobPosition: 'Onder-Directeur', unit: 'HO-DIR', roles: ['ONDER_DIRECTEUR'] },
  { ref: 'SYN-USER-01', email: 'assistant1@juspol.test', fullName: 'L. Amatredjo', jobPosition: 'Administrative assistant', unit: 'HO-KAB', roles: ['SUPPORT_STAFF'] },
  { ref: 'SYN-USER-02', email: 'assistant2@juspol.test', fullName: 'K. Pawironadi', jobPosition: 'Registration clerk', unit: 'HO-DIR', roles: ['SUPPORT_STAFF'] },
  { ref: 'SYN-USER-03', email: 'unauthorised@juspol.test', fullName: 'D. Oemrawsingh', jobPosition: 'Administrative assistant (control account for access tests)', unit: 'HO-DIR', roles: ['SUPPORT_STAFF'] },
  { ref: 'SYN-ADMIN-01', email: 'sysadmin@juspol.test', fullName: 'V. Ramlal', jobPosition: 'Pilot system administrator', unit: 'HO-ICT', roles: ['SYS_ADMIN'] },
  { ref: 'SYN-MULTI-01', email: 'dualrole@juspol.test', fullName: 'S. Hiwat', jobPosition: 'Onder-Directeur, also acting support', unit: 'HO-DIR', roles: ['ONDER_DIRECTEUR', 'SUPPORT_STAFF'] },
  { ref: 'SYN-DISABLED-01', email: 'disabled@juspol.test', fullName: 'J. Kensmil', jobPosition: 'Former assistant (disabled account)', unit: 'HO-DIR', roles: ['SUPPORT_STAFF'], disabled: true },
];

export async function seedAll(): Promise<void> {
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error('SEED_PASSWORD is not set. Copy .env.example to .env.');

  await AppDataSource.initialize();
  const roleRepo = AppDataSource.getRepository(FunctionalRole);
  const unitRepo = AppDataSource.getRepository(OrganisationalUnit);
  const personRepo = AppDataSource.getRepository(Person);
  const accountRepo = AppDataSource.getRepository(Account);
  const assignmentRepo = AppDataSource.getRepository(RoleAssignment);

  for (const role of ROLES) {
    if (!(await roleRepo.findOne({ where: { code: role.code } }))) {
      await roleRepo.save(roleRepo.create(role));
    }
  }
  for (const unit of UNITS) {
    if (!(await unitRepo.findOne({ where: { code: unit.code } }))) {
      await unitRepo.save(unitRepo.create(unit));
    }
  }

  const passwordHash = await hashPassword(password);
  let created = 0;

  for (const user of USERS) {
    if (await accountRepo.findOne({ where: { email: user.email } })) continue;

    const person = await personRepo.save(
      personRepo.create({ fullName: user.fullName, jobPosition: user.jobPosition }),
    );
    const unit = await unitRepo.findOne({ where: { code: user.unit } });
    const account = await accountRepo.save(
      accountRepo.create({
        email: user.email,
        passwordHash,
        isEnabled: user.disabled !== true,
        person,
        organisationalUnit: unit,
      }),
    );

    for (const roleCode of user.roles) {
      const role = await roleRepo.findOne({ where: { code: roleCode } });
      if (role) {
        await assignmentRepo.save(assignmentRepo.create({ account, role }));
      }
    }
    created += 1;
    // eslint-disable-next-line no-console
    console.log(`created ${user.ref.padEnd(16)} ${user.email}`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nSeed complete. ${created} account(s) created, ${USERS.length - created} already present.`);
  await AppDataSource.destroy();
}

// Run only when invoked directly (npm run seed), not when imported by a test.
if (require.main === module) {
  seedAll().catch((error) => {
  // eslint-disable-next-line no-console
    console.error('Seed failed:', error.message);
    process.exit(1);
  });
}
