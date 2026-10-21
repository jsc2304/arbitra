import type { CaseTemplate, CreateCaseTemplateInput } from '@arbitra/shared';
import { collections } from '../../lib/firestore.js';
import { generateId } from '../../lib/ids.js';

export class CaseTemplateService {
  async create(input: CreateCaseTemplateInput, actorId: string): Promise<CaseTemplate> {
    const now = new Date().toISOString();
    const template: CaseTemplate = {
      template_id: generateId('caseTemplate'),
      project_id: input.project_id,
      name: input.name,
      description: input.description ?? '',
      defaults: input.defaults,
      created_by: actorId,
      created_at: now,
      updated_at: now,
    };
    await collections.caseTemplates().doc(template.template_id).set(template);
    return template;
  }

  async listByProject(projectId: string): Promise<CaseTemplate[]> {
    const snap = await collections.caseTemplates()
      .where('project_id', '==', projectId)
      .orderBy('name')
      .get();
    return snap.docs.map((d) => d.data());
  }

  async getById(templateId: string): Promise<CaseTemplate | null> {
    const doc = await collections.caseTemplates().doc(templateId).get();
    return doc.exists ? (doc.data() as CaseTemplate) : null;
  }

  async update(templateId: string, updates: Partial<Pick<CaseTemplate, 'name' | 'description' | 'defaults'>>): Promise<CaseTemplate> {
    const ref = collections.caseTemplates().doc(templateId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error(`Template ${templateId} not found`);

    await ref.update({ ...updates, updated_at: new Date().toISOString() });
    const updated = await ref.get();
    return updated.data() as CaseTemplate;
  }

  async delete(templateId: string): Promise<void> {
    await collections.caseTemplates().doc(templateId).delete();
  }
}
