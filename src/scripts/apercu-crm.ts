import { config, essortMembers } from '../config';
import { listPlannedTasks } from '../db/essortRepository';
import { buildCrmAgenda, fetchCrm } from '../essort/crm';
import { addDays, duplicatesCrm, padDate, PING_OFFSETS_MIN, shortDate } from '../essort/planner';
import { parisDateValue } from '../lib/datetime';

/**
 * Ce que le bot posera sur chaque tableau d'après le CRM, SANS RIEN ÉCRIRE
 * (ni Discord, ni base) : pour vérifier la route du CRM et sa lecture.
 *
 *   npm run apercu-crm
 *
 * Lit `CRM_URL` + `CRM_SECRET` (le .env du bot), et les tâches déjà posées sur
 * les tableaux (base du bot, en lecture) pour dire lesquelles l'emportent sur
 * une action du CRM.
 */

/** 'HH:MM' moins `minutes`. */
function before(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const t = (h ?? 0) * 60 + (m ?? 0) - minutes;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const today = padDate(parisDateValue(0));
  const agenda = buildCrmAgenda(await fetchCrm(), today);
  console.log(`CRM lu sur ${config.CRM_URL}, le ${shortDate(today)}.\n`);

  for (const { person } of essortMembers) {
    const plan = agenda.people[person];
    const written = (await listPlannedTasks(person, today, addDays(today, 7))).filter(
      (t) => t.source === 'manual',
    );
    const writtenOn = (date: string, a: Parameters<typeof duplicatesCrm>[1]) =>
      written.find(
        (t) =>
          t.essort_boards.board_date === date &&
          duplicatesCrm({ label: t.label, time: t.due_time }, a),
      );

    console.log(`=== ${person} : aujourd'hui (${plan.due.length})`);
    for (const d of plan.due) {
      const twin = writtenOn(today, d);
      const pings =
        d.time && !twin
          ? `  pings ${PING_OFFSETS_MIN.map((m) => before(d.time!, m)).join(', ')}`
          : '';
      console.log(
        `- ${d.time ?? '     '}  ${d.label}${d.details ? `  (${d.details})` : ''}${pings}`,
      );
      if (twin) console.log(`    déjà écrite à la main : « ${twin.label} » l'emporte`);
    }
    console.log(`=== ${person} : la semaine (${plan.upcoming.length})`);
    for (const u of plan.upcoming) {
      const twin = writtenOn(u.date, u);
      console.log(
        `- ${shortDate(u.date)} ${u.time ?? '     '}  ${u.label}${twin ? `  (déjà écrite : « ${twin.label} »)` : ''}`,
      );
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
