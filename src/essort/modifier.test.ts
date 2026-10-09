import { describe, expect, it } from 'vitest';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import { parseDayInput } from './planner';
import { buildDayComponents, buildEditModal, buildEditPickMenu } from './ui';

const today = '2026-10-09'; // un vendredi

describe('jour tapé à la main', () => {
  it('comprend les jours relatifs, les jours de la semaine et les dates', () => {
    expect(parseDayInput('aujourd’hui', today)).toBe(today);
    expect(parseDayInput('Demain', today)).toBe('2026-10-10');
    expect(parseDayInput('après-demain', today)).toBe('2026-10-11');
    expect(parseDayInput('lundi', today)).toBe('2026-10-12');
    expect(parseDayInput('lun.', today)).toBe('2026-10-12');
    expect(parseDayInput('vendredi', today)).toBe(today);
    expect(parseDayInput('12/10', today)).toBe('2026-10-12');
    expect(parseDayInput('Mardi 13/10', today)).toBe('2026-10-13');
  });

  it('refuse ce qu’il ne comprend pas', () => {
    expect(parseDayInput('', today)).toBeNull();
    expect(parseDayInput('bientôt', today)).toBeNull();
    expect(parseDayInput('31/02', today)).toBeNull();
  });
});

const board = { id: 7, person: 'Loys', board_date: today, archived_at: null } as EssortBoardRow;
const task = (partial: Partial<EssortTaskRow>) =>
  ({
    id: 42,
    label: 'R2 avec Chloé',
    due_time: '10:00',
    is_done: false,
    source: 'manual',
    ...partial,
  }) as EssortTaskRow;

describe('modifier une tâche', () => {
  it('le message du jour propose « Modifier » tant qu’une tâche reste à faire', () => {
    const labels = (done: boolean) =>
      (
        buildDayComponents(board, [task({ is_done: done })])
          .at(-1)!
          .toJSON().components as {
          label: string;
          disabled?: boolean;
        }[]
      ).map((b) => [b.label, Boolean(b.disabled)]);
    expect(labels(false)).toEqual([
      ['Ajouter', false],
      ['Modifier', false],
      ['Retirer', false],
    ]);
    expect(labels(true)[1]).toEqual(['Modifier', true]);
  });

  it('la liste de la semaine montre le jour de chaque tâche', () => {
    const menu = buildEditPickMenu(board, [{ task: task({}), date: '2026-10-12' }], true).toJSON()
      .components[0] as { custom_id: string; options: { label: string; description: string }[] };
    expect(menu.custom_id).toBe('essort:editpick:7');
    expect(menu.options[0]).toMatchObject({
      label: '10:00 · R2 avec Chloé',
      description: 'Lundi 12/10',
    });
  });

  it('le formulaire est prérempli avec le texte, le jour et l’heure', () => {
    const modal = buildEditModal(7, task({}), '2026-10-12').toJSON();
    expect(modal.custom_id).toBe('essort:editmodal:7:42');
    const values = modal.components.map((row) => (row.components[0] as { value?: string }).value);
    expect(values).toEqual(['R2 avec Chloé', 'Lundi 12/10', '10:00']);
    const sansHeure = buildEditModal(7, task({ due_time: null }), today).toJSON();
    expect((sansHeure.components[2]!.components[0] as { value?: string }).value).toBe('');
  });
});
