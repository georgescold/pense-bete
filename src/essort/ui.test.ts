import { describe, expect, it } from 'vitest';
import type { EssortBoardRow, EssortTaskRow } from '../db/essortRepository';
import { boardIntro, buildBoardComponents, buildBoardEmbed } from './ui';

function board(partial: Partial<EssortBoardRow> = {}): EssortBoardRow {
  return {
    id: 1,
    person: 'Enzo',
    board_date: '2026-10-08',
    channel_id: 'c',
    message_id: null,
    extras: {},
    read_at: '2026-10-08T04:00:00Z',
    archived_at: null,
    created_at: '',
    ...partial,
  };
}

function task(id: number, partial: Partial<EssortTaskRow> = {}): EssortTaskRow {
  return {
    id,
    board_id: 1,
    source: 'airtable',
    record_id: 'recABCDEFGHIJKLMN',
    signature: 'a call|2026-10-08',
    label: `📞 Appeler Prénom Nom ${id} · Cabinet d’architecture au nom assez long`,
    details: `${'Rappel prévu en fin de matinée, préparer le devis et les références '.repeat(2)} · ☎ 06 00 00 00 00 · 🟢 Chaud`,
    position: id,
    is_done: false,
    done_at: null,
    done_by: null,
    dismissed_at: null,
    sheet_range: null,
    created_at: '',
    ...partial,
  };
}

/** Somme des textes comptés par Discord pour la limite de 6 000 caractères. */
function embedSize(json: ReturnType<ReturnType<typeof buildBoardEmbed>['toJSON']>): number {
  return (
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.author?.name.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    (json.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

describe('buildBoardEmbed', () => {
  it('reste sous les limites de Discord même chargé', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `Lead numéro ${i} · Cabinet ${i} — Attente de doc`,
    );
    const tasks = Array.from({ length: 25 }, (_, i) => task(i + 1));
    const json = buildBoardEmbed(
      board({
        extras: {
          airtableError: true,
          stale: long.map((label) => ({ label, doneOn: '2026-10-07' })),
          upcoming: long.map((label) => ({ date: '2026-10-09', label })),
          undated: long,
          unassigned: long,
        },
      }),
      tasks,
    ).toJSON();
    expect(json.description!.length).toBeLessThanOrEqual(4096);
    for (const f of json.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(embedSize(json)).toBeLessThanOrEqual(6000);
  });

  it('affiche les détails et le lien de la fiche des tâches à faire', () => {
    const json = buildBoardEmbed(board(), [task(1, { details: 'Jeudi 11h' })]).toJSON();
    expect(json.description).toContain('↳ Jeudi 11h · [fiche Airtable](https://airtable.com/');
  });

  it('barre une tâche faite sans ses détails', () => {
    const json = buildBoardEmbed(board(), [task(1, { is_done: true, label: 'Fait' })]).toJSON();
    expect(json.description).toContain('~~Fait~~');
    expect(json.description).not.toContain('↳');
  });
});

describe('buildBoardComponents', () => {
  it('ne laisse aucun bouton sur un tableau archivé', () => {
    expect(buildBoardComponents(board({ archived_at: '2026-10-09T04:00:00Z' }), [task(1)])).toEqual(
      [],
    );
  });

  it('tient dans les 5 lignes de Discord au-delà de 20 tâches', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(i + 1));
    expect(buildBoardComponents(board(), tasks).length).toBeLessThanOrEqual(5);
  });
});

describe('boardIntro', () => {
  it('ne mentionne que s’il reste quelque chose à faire', () => {
    expect(boardIntro('<@1>', 2, 3)).toBe('<@1> 2 tâches aujourd’hui.');
    expect(boardIntro('<@1>', 1, 1)).toBe('<@1> 1 tâche aujourd’hui.');
    expect(boardIntro('<@1>', 0, 3)).toBe('Tout est fait pour aujourd’hui. ✅');
    expect(boardIntro('<@1>', 0, 0)).toBe('Rien à faire aujourd’hui côté Essort.');
  });
});
