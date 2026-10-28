import { Harness, accountIdFor, expectAuditEvent, signIn, startHarness } from './harness';

/**
 * Tasks and actions, brought over from Workflow Task Management and placed
 * inside the record system: linked to letters and matters, audited, never
 * deleted, and visible only to the people who should see them.
 */
describe('Phase 3 tasks', () => {
  let h: Harness;
  const future = (days: number) => {
    const d = new Date(Date.now() + days * 86400000);
    return d.toISOString().slice(0, 10);
  };
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function registeredLetter(subject = `Brief ${Math.random()}`) {
    const { agent } = await signIn(h.app, 'assistant1@juspol.test');
    const draft = (await agent.post('/api/records/drafts').send({ direction: 'INCOMING', subject, party: 'Korps Politie Suriname' }).expect(201)).body;
    return (await agent.post(`/api/records/${draft.id}/register`).send({ version: draft.version }).expect(200)).body;
  }

  it('creates an action from a letter, notifies the assignee and records it', async () => {
    const letter = await registeredLetter('Verzoek om cijfers');
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const assignee = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const task = (
      await directeur
        .post('/api/tasks')
        .send({ title: 'Cijfers aanleveren', assigneeAccountId: assignee, itemId: letter.id, dueDate: future(10), priority: 'HIGH', checklist: ['Opvragen', 'Controleren'] })
        .expect(201)
    ).body;
    expect(task.reference).toMatch(/^TAAK-\d{4}-0001$/);
    expect(task.item.identity).toBe(letter.registrationIdentity);
    expect(task.checklistTotal).toBe(2);
    expect(task.status).toBe('OPEN');
    await expectAuditEvent(h.db, 'TASK_CREATED', task.reference);
    const [note] = await h.db.query(`SELECT * FROM notification WHERE account_id = $1 AND kind = 'TASK_ASSIGNED'`, [assignee]);
    expect(note.title).toContain('Cijfers aanleveren');
    expect(note.link).toBe(`/taken/${task.id}`);
  });

  it('lets only the assignee accept or decline, and a decline needs a reason', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const assignee = await accountIdFor(h.db, 'assistant2@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Archief ordenen', assigneeAccountId: assignee }).expect(201)).body;
    await directeur.post(`/api/tasks/${task.id}/accept`).send({ version: task.version }).expect(403);
    const { agent: clerk } = await signIn(h.app, 'assistant2@juspol.test');
    await clerk.post(`/api/tasks/${task.id}/reject`).send({ version: task.version, reason: '' }).expect(400);
    const rejected = (await clerk.post(`/api/tasks/${task.id}/reject`).send({ version: task.version, reason: 'Geen capaciteit deze week' }).expect(200)).body;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('Geen capaciteit deze week');
    // The owner reassigns; the task opens again for the new person.
    const other = await accountIdFor(h.db, 'unauthorised@juspol.test');
    const reassigned = (await directeur.put(`/api/tasks/${task.id}`).send({ version: rejected.version, assigneeAccountId: other }).expect(200)).body;
    expect(reassigned.status).toBe('OPEN');
    expect(reassigned.assignee.accountId).toBe(other);
    await expectAuditEvent(h.db, 'TASK_ASSIGNED', task.reference);
  });

  it('refuses completion while checklist items or subtasks are open', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const assigneeId = await accountIdFor(h.db, 'assistant1@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Nota opstellen', assigneeAccountId: assigneeId, checklist: ['Concept'] }).expect(201)).body;
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    let detail = (await clerk.get(`/api/tasks/${task.id}`).expect(200)).body;
    await clerk.post(`/api/tasks/${task.id}/complete`).send({ version: detail.task.version }).expect(400);
    const sub = (await clerk.post(`/api/tasks/${task.id}/subtasks`).send({ title: 'Bijlage maken', assigneeAccountId: assigneeId }).expect(201)).body;
    expect(sub.parentReference).toBe(task.reference);
    detail = (await clerk.patch(`/api/tasks/${task.id}/checklist/${detail.checklist[0].id}`).send({ done: true }).expect(200)).body;
    expect(detail.checklist[0].done).toBe(true);
    expect(detail.checklist[0].doneByName).toBe('L. Amatredjo');
    const blocked = await clerk.post(`/api/tasks/${task.id}/complete`).send({ version: detail.task.version }).expect(400);
    expect(blocked.body.message).toContain('subtask');
    await clerk.post(`/api/tasks/${sub.id}/complete`).send({ version: sub.version }).expect(200);
    detail = (await clerk.get(`/api/tasks/${task.id}`).expect(200)).body;
    const done = (await clerk.post(`/api/tasks/${task.id}/complete`).send({ version: detail.task.version }).expect(200)).body;
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    const owner = await accountIdFor(h.db, 'directeur@juspol.test');
    const notes = await h.db.query(`SELECT kind FROM notification WHERE account_id = $1 AND kind = 'TASK_COMPLETED'`, [owner]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('never deletes a task: cancelling needs a reason, and the row stays', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Wordt geannuleerd', assigneeAccountId: await accountIdFor(h.db, 'assistant1@juspol.test') }).expect(201)).body;
    await directeur.post(`/api/tasks/${task.id}/cancel`).send({ version: task.version, reason: '' }).expect(400);
    const cancelled = (await directeur.post(`/api/tasks/${task.id}/cancel`).send({ version: task.version, reason: 'Niet meer nodig' }).expect(200)).body;
    expect(cancelled.status).toBe('CANCELLED');
    await directeur.post(`/api/tasks/${task.id}/archive`).expect(200);
    // There is no delete route, and a delete in SQL does nothing.
    await directeur.delete(`/api/tasks/${task.id}`).expect(404);
    await h.db.query(`DELETE FROM task WHERE id = $1`, [task.id]);
    const [row] = await h.db.query(`SELECT status, cancelled_reason, archived_at FROM task WHERE id = $1`, [task.id]);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelled_reason).toBe('Niet meer nodig');
    expect(row.archived_at).not.toBeNull();
    // Archived tasks leave the list unless asked for.
    const list = (await directeur.get('/api/tasks?scope=owner').expect(200)).body;
    expect(list.data.map((t: { id: string }) => t.id)).not.toContain(task.id);
    const withArchived = (await directeur.get('/api/tasks?scope=owner&includeArchived=true').expect(200)).body;
    expect(withArchived.data.map((t: { id: string }) => t.id)).toContain(task.id);
  });

  it('keeps comments as written and notifies the people mentioned', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const assignee = await accountIdFor(h.db, 'assistant1@juspol.test');
    const minister = await accountIdFor(h.db, 'minister@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Reactie voorbereiden', assigneeAccountId: assignee }).expect(201)).body;
    const detail = (await directeur.post(`/api/tasks/${task.id}/comments`).send({ body: `Graag afstemmen met @[R. Dijkstra](${minister}) vóór vrijdag.` }).expect(201)).body;
    expect(detail.comments).toHaveLength(1);
    const mention = await h.db.query(`SELECT title FROM notification WHERE account_id = $1 AND kind = 'TASK_MENTION'`, [minister]);
    expect(mention[0].title).toContain('noemde u');
    const comment = await h.db.query(`SELECT id, body FROM task_comment WHERE task_id = $1`, [task.id]);
    await h.db.query(`UPDATE task_comment SET body = 'gewijzigd' WHERE id = $1`, [comment[0].id]);
    const [after] = await h.db.query(`SELECT body FROM task_comment WHERE id = $1`, [comment[0].id]);
    expect(after.body).toBe(comment[0].body);
  });

  it('stores attachments with their fingerprint and refuses malware', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Met bijlage', assigneeAccountId: await accountIdFor(h.db, 'directeur@juspol.test') }).expect(201)).body;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const detail = (await directeur.post(`/api/tasks/${task.id}/attachments`).attach('file', pdf, { filename: 'notitie.pdf', contentType: 'application/pdf' }).expect(201)).body;
    expect(detail.attachments[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    const download = await directeur.get(`/api/tasks/${task.id}/attachments/${detail.attachments[0].id}/content`).expect(200);
    expect(Buffer.from(download.body).toString()).toContain('%PDF');
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const refused = await directeur.post(`/api/tasks/${task.id}/attachments`).attach('file', eicar, { filename: 'virus.pdf', contentType: 'application/pdf' }).expect(422);
    expect(refused.body.message).toContain('malware');
    const [scan] = await h.db.query(`SELECT result, signature FROM document_scan WHERE filename = 'virus.pdf'`);
    expect(scan.result).toBe('INFECTED');
  });

  it('shows the action in the matter’s timeline', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const dossier = (await clerk.post('/api/dossiers').send({ subject: 'Matter with an action' }).expect(201)).body;
    const task = (await clerk.post('/api/tasks').send({ title: 'Advies inwinnen', assigneeAccountId: await accountIdFor(h.db, 'onderdirecteur@juspol.test'), dossierId: dossier.id }).expect(201)).body;
    const timeline = (await clerk.get(`/api/dossiers/${dossier.id}/timeline`).expect(200)).body;
    const entry = timeline.find((e: { kind: string }) => e.kind === 'TASK_CREATED');
    expect(entry.headline).toContain(task.reference);
    expect(entry.detail).toBe('Advies inwinnen');
  });

  it('hides tasks on a classified matter from people outside it', async () => {
    const { agent: minister } = await signIn(h.app, 'minister@juspol.test');
    const secret = (await minister.post('/api/dossiers').send({ subject: 'Geheim', classification: 'SECRET' }).expect(201)).body;
    const self = await accountIdFor(h.db, 'minister@juspol.test');
    const task = (await minister.post('/api/tasks').send({ title: 'Geheime actie', assigneeAccountId: self, dossierId: secret.id }).expect(201)).body;
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    // A manager sees all tasks — but not this one.
    const all = (await directeur.get('/api/tasks?scope=all').expect(200)).body;
    expect(all.data.map((t: { id: string }) => t.id)).not.toContain(task.id);
    await directeur.get(`/api/tasks/${task.id}`).expect(404);
    // Someone the task involves cannot create an action on a matter they cannot see.
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    await clerk.post('/api/tasks').send({ title: 'x', assigneeAccountId: self, dossierId: secret.id }).expect(404);
  });

  it('applies a template with its checklist and subtasks', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const template = (
      await directeur
        .post('/api/task-templates')
        .send({
          name: 'Parlementaire vraag beantwoorden',
          titleTemplate: 'Beantwoorden: {subject}',
          defaultPriority: 'HIGH',
          defaultDueWorkingDays: 15,
          checklist: ['Feiten verzamelen', 'Juridische toets', 'Concept antwoord'],
          subtasks: [{ title: 'Input Korps Politie opvragen', dueOffsetWorkingDays: 5 }],
        })
        .expect(201)
    ).body;
    await directeur.post('/api/task-templates').send({ name: 'parlementaire vraag beantwoorden', titleTemplate: 'x' }).expect(409);
    const letter = await registeredLetter('Vragen over jeugdcriminaliteit');
    const assignee = await accountIdFor(h.db, 'onderdirecteur@juspol.test');
    const task = (await directeur.post(`/api/task-templates/${template.id}/apply`).send({ assigneeAccountId: assignee, itemId: letter.id }).expect(201)).body;
    expect(task.title).toBe('Beantwoorden: Vragen over jeugdcriminaliteit');
    expect(task.checklistTotal).toBe(3);
    expect(task.priority).toBe('HIGH');
    expect(task.dueDate).not.toBeNull();
    const detail = (await directeur.get(`/api/tasks/${task.id}`).expect(200)).body;
    expect(detail.subtasks).toHaveLength(1);
    expect(detail.subtasks[0].title).toBe('Input Korps Politie opvragen');
    expect(detail.subtasks[0].dueDate <= task.dueDate).toBe(true);
  });

  it('creates the next occurrence of a repeating task when one is completed', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const self = await accountIdFor(h.db, 'directeur@juspol.test');
    const due = future(3);
    const task = (await directeur.post('/api/tasks').send({ title: 'Weekrapportage', assigneeAccountId: self, dueDate: due, recurrence: 'WEEKLY', checklist: ['Cijfers'] }).expect(201)).body;
    const detail = (await directeur.get(`/api/tasks/${task.id}`).expect(200)).body;
    await directeur.patch(`/api/tasks/${task.id}/checklist/${detail.checklist[0].id}`).send({ done: true }).expect(200);
    const fresh = (await directeur.get(`/api/tasks/${task.id}`).expect(200)).body;
    await directeur.post(`/api/tasks/${task.id}/complete`).send({ version: fresh.task.version }).expect(200);
    const series = await h.db.query(`SELECT id, due_date::text AS due, status, source FROM task WHERE title = 'Weekrapportage' ORDER BY created_at`);
    expect(series).toHaveLength(2);
    expect(series[1].source).toBe('RECURRENCE');
    expect(series[1].status).toBe('OPEN');
    expect(series[1].due > due).toBe(true);
    const checklist = await h.db.query(`SELECT done FROM task_checklist_item WHERE task_id = $1`, [series[1].id]);
    expect(checklist).toEqual([{ done: false }]);
  });

  it('assigns many tasks at once and reports the ones it skipped', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const a = await accountIdFor(h.db, 'assistant1@juspol.test');
    const b = await accountIdFor(h.db, 'assistant2@juspol.test');
    const t1 = (await directeur.post('/api/tasks').send({ title: 'Bulk 1', assigneeAccountId: a }).expect(201)).body;
    const t2 = (await directeur.post('/api/tasks').send({ title: 'Bulk 2', assigneeAccountId: b }).expect(201)).body;
    const result = (await directeur.post('/api/tasks/bulk-assign').send({ taskIds: [t1.id, t2.id], assigneeAccountId: b }).expect(200)).body;
    expect(result.updated).toEqual([t1.id]);
    expect(result.skipped[0].reason).toBe('already assigned');
  });

  it('counts and filters by scope and deadline', async () => {
    const { agent: clerk } = await signIn(h.app, 'assistant1@juspol.test');
    const counts = (await clerk.get('/api/tasks/counts').expect(200)).body;
    expect(counts.my).toBeGreaterThan(0);
    const mine = (await clerk.get('/api/tasks?scope=my').expect(200)).body;
    expect(mine.data.every((t: { assignee: { name: string } }) => t.assignee.name === 'L. Amatredjo')).toBe(true);
    await h.db.query(`UPDATE task SET due_date = current_date - 3 WHERE title = 'Nota opstellen' AND status <> 'COMPLETED'`);
    const overdue = (await clerk.get('/api/tasks?scope=my&due=overdue').expect(200)).body;
    expect(overdue.data.every((t: { overdue: boolean }) => t.overdue)).toBe(true);
  });

  it('refuses a stale edit instead of overwriting someone else’s change', async () => {
    const { agent: directeur } = await signIn(h.app, 'directeur@juspol.test');
    const task = (await directeur.post('/api/tasks').send({ title: 'Versie', assigneeAccountId: await accountIdFor(h.db, 'assistant1@juspol.test') }).expect(201)).body;
    await directeur.put(`/api/tasks/${task.id}`).send({ version: task.version, priority: 'LOW' }).expect(200);
    await directeur.put(`/api/tasks/${task.id}`).send({ version: task.version, priority: 'HIGH' }).expect(409);
  });
});
