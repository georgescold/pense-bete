import { describe, expect, it } from 'vitest';
import type { CrmAction } from './planner';
import { changedActions } from './service';
import { crmUpdateMessage } from './ui';

const action = (partial: Partial<CrmAction>): CrmAction => ({
  key: 'recA|r2|2026-10-13',
  date: '2026-10-13',
  time: '14:00',
  label: 'R2 avec Vincent',
  ...partial,
});

describe('synchro CRM', () => {
  it('ne signale que les actions nouvelles ou modifiées', () => {
    const before = new Map([[action({}).key, action({})]]);
    expect(changedActions(before, [action({})])).toEqual([]);
    const moved = action({ time: '15:00' });
    const added = action({
      key: 'recB|a call|2026-10-12',
      date: '2026-10-12',
      label: 'Appeler Paul',
    });
    expect(changedActions(before, [moved, added])).toEqual([moved, added]);
  });

  it('dit en une ligne par action ce que le bot a compris', () => {
    const today = '2026-10-09';
    expect(
      crmUpdateMessage(
        [
          action({ date: '2026-10-08', time: null, label: 'Appeler Paul' }),
          action({ date: today, time: null, label: 'Préparer le R2 avec Chloé' }),
          action({ date: '2026-10-10', time: '09:30', label: 'R1 avec Anne' }),
          action({}),
        ],
        today,
      ),
    ).toBe(
      [
        'Agenda mis à jour depuis le CRM :',
        '- En retard (prévu le 08/10) · Appeler Paul',
        '- Aujourd’hui · Préparer le R2 avec Chloé',
        '- Demain · `09:30` R1 avec Anne',
        '- Mardi 13/10 · `14:00` R2 avec Vincent',
      ].join('\n'),
    );
  });
});
