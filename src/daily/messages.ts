/**
 * Messages du module journées.
 *
 * Volontairement neutres et factuels : pas de variantes tirées au sort, pas
 * d'encouragement, pas de reproche. Le bot énonce un état, l'interprétation
 * est laissée à l'utilisateur. Un même contexte produit toujours le même
 * texte, ce qui rend aussi le comportement prévisible et testable.
 */

// --- 18h : préparation du lendemain ---------------------------------------

export function prepIntro(date: string): string {
  return `préparation de la journée du **${date}**.`;
}

// --- 7h : ouverture de la journée -----------------------------------------

export function boardIntro(taskCount: number, isRest = false): string {
  if (isRest) return 'journée de repos.';
  if (taskCount === 0) return 'aucune tâche enregistrée pour aujourd’hui.';
  return 'tâches du jour.';
}

// --- Pied de page de la checklist ------------------------------------------

/**
 * `seed` n'est plus utilisé — il servait à figer une variante aléatoire par
 * journée. Conservé dans la signature tant que l'appelant le fournit.
 */
export function boardFooter(allDone: boolean, _seed?: number): string {
  return allDone ? 'Toutes les tâches sont cochées' : 'Clique sur un numéro pour cocher';
}

// --- Clôture de la journée -------------------------------------------------

export function closingLine(done: number, total: number, isRest = false): string {
  const prefix = isRest ? 'Journée de repos close.' : 'Journée close.';
  if (total === 0) return `${prefix} Aucune tâche enregistrée.`;
  return `${prefix} ${done}/${total} tâche(s) cochée(s).`;
}
